import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProviderApiBaseUrl } from '../git-providers/config.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'gitea-auth.json');

// Gitea/Forgejo are self-hosted — there is deliberately NO built-in default
// base URL. The instance URL is always user-provided (see `normalizeBaseUrl`);
// auth.js never invents a host for a stored account. A configured
// settings.json gitProviders.gitea.apiBaseUrl can act as the default for the
// connect form, but stored accounts still require an explicit baseUrl.

/** Effective default Gitea base URL: configured settings.json value, else null (no built-in default). */
export function getGiteaDefaultBaseUrl() {
  return getProviderApiBaseUrl('gitea');
}

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function readJsonFile() {
  ensureStorageDir();
  if (!fs.existsSync(STORAGE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read Gitea auth file:', error);
    return null;
  }
}

function writeJsonFile(payload) {
  ensureStorageDir();

  // Atomic write so multiple OpenChamber instances can safely share the same file.
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }

  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Normalize a user-provided Gitea/Forgejo base URL. Adds `https://` when no
 * scheme is present, strips a trailing slash, and returns null for anything
 * unparseable. There is no default base URL: self-hosted Gitea instances are
 * always named explicitly by the user.
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let value = raw.trim();
  if (!value) {
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/+$/, '');
}

function hostFromBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized).hostname || null;
  } catch {
    return null;
  }
}

function resolveAccountId({ username, accessToken, baseUrl, accountId }) {
  if (typeof accountId === 'string' && accountId.trim()) {
    return accountId.trim();
  }
  const host = hostFromBaseUrl(baseUrl);
  if (typeof username === 'string' && username.trim()) {
    return host ? `${host}:${username.trim()}` : username.trim();
  }
  if (typeof accessToken === 'string' && accessToken.trim()) {
    return `token:${accessToken.slice(0, 8)}`;
  }
  return '';
}

function normalizeAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accessToken = typeof entry.accessToken === 'string' ? entry.accessToken : '';
  if (!accessToken) return null;
  const baseUrl = normalizeBaseUrl(entry.baseUrl);
  // No default base URL exists for Gitea; an entry without a usable instance
  // URL cannot make any API call, so it is dropped.
  if (!baseUrl) return null;
  const username = typeof entry.username === 'string' ? entry.username : '';

  const accountId = resolveAccountId({
    username,
    accessToken,
    baseUrl,
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
  });

  return {
    accessToken,
    baseUrl,
    username: username || null,
    name: typeof entry.name === 'string' ? entry.name : null,
    avatarUrl: typeof entry.avatarUrl === 'string' ? entry.avatarUrl : null,
    webUrl: typeof entry.webUrl === 'string' ? entry.webUrl : null,
    email: typeof entry.email === 'string' ? entry.email : null,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    current: Boolean(entry.current),
    accountId,
  };
}

function normalizeAuthList(raw) {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((entry) => normalizeAuthEntry(entry))
    .filter(Boolean);

  if (!list.length) {
    return { list: [], changed: false };
  }

  let changed = false;
  let currentFound = false;
  list.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && list[0]) {
    list[0].current = true;
    changed = true;
  }

  list.forEach((entry) => {
    if (!entry.accountId) {
      entry.accountId = resolveAccountId(entry);
      changed = true;
    }
  });

  return { list, changed };
}

function readAuthList() {
  const data = readJsonFile();
  if (!data) {
    return [];
  }
  const { list, changed } = normalizeAuthList(data);
  if (changed) {
    writeJsonFile(list);
  }
  return list;
}

function writeAuthList(list) {
  writeJsonFile(list);
}

export function getGiteaAuth() {
  const list = readAuthList();
  if (!list.length) {
    return null;
  }
  const current = list.find((entry) => entry.current) || list[0];
  if (!current?.accessToken) {
    return null;
  }
  return current;
}

export function getGiteaAuthAccounts() {
  const list = readAuthList();
  return list
    .filter((entry) => entry?.accountId && entry?.baseUrl)
    .map((entry) => ({
      id: entry.accountId,
      user: {
        username: entry.username || null,
        name: entry.name || null,
        avatarUrl: entry.avatarUrl || null,
        webUrl: entry.webUrl || null,
      },
      baseUrl: entry.baseUrl,
      current: Boolean(entry.current),
    }));
}

export function setGiteaAuth({ accessToken, baseUrl, user }) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('accessToken is required');
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error('baseUrl is required and must be a valid URL');
  }
  // Gitea/Forgejo `GET /user` uses `login`/`full_name`; tolerate the snake_case
  // variants too so stored entries stay robust across API versions.
  const normalizedUser = user && typeof user === 'object'
    ? {
      username: typeof user.login === 'string' ? user.login : (typeof user.username === 'string' ? user.username : undefined),
      name: typeof user.full_name === 'string' ? user.full_name : (typeof user.name === 'string' ? user.name : undefined),
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
      webUrl: typeof user.html_url === 'string' ? user.html_url : (typeof user.web_url === 'string' ? user.web_url : undefined),
      email: typeof user.email === 'string' ? user.email : undefined,
    }
    : undefined;

  const username = normalizedUser?.username || '';
  const resolvedAccountId = resolveAccountId({
    username,
    accessToken,
    baseUrl: normalizedBaseUrl,
    accountId: '',
  });

  const list = readAuthList();
  const existingIndex = list.findIndex((entry) => entry.accountId === resolvedAccountId);
  const nextEntry = {
    accessToken,
    baseUrl: normalizedBaseUrl,
    username: username || null,
    name: normalizedUser?.name ?? null,
    avatarUrl: normalizedUser?.avatarUrl ?? null,
    webUrl: normalizedUser?.webUrl ?? null,
    email: normalizedUser?.email ?? null,
    createdAt: Date.now(),
    current: true,
    accountId: resolvedAccountId,
  };

  if (existingIndex >= 0) {
    list[existingIndex] = nextEntry;
  } else {
    list.push(nextEntry);
  }

  list.forEach((entry, index) => {
    entry.current = index === (existingIndex >= 0 ? existingIndex : list.length - 1);
  });
  writeAuthList(list);
  return nextEntry;
}

export function activateGiteaAuth(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return false;
  }
  const list = readAuthList();
  const index = list.findIndex((entry) => entry.accountId === accountId.trim());
  if (index === -1) {
    return false;
  }
  list.forEach((entry, idx) => {
    entry.current = idx === index;
  });
  writeAuthList(list);
  return true;
}

export function clearGiteaAuth() {
  try {
    const list = readAuthList();
    if (!list.length) {
      return true;
    }
    const remaining = list.filter((entry) => !entry.current);
    if (!remaining.length) {
      if (fs.existsSync(STORAGE_FILE)) {
        fs.unlinkSync(STORAGE_FILE);
      }
      return true;
    }
    remaining.forEach((entry, index) => {
      entry.current = index === 0;
    });
    writeAuthList(remaining);
    return true;
  } catch (error) {
    console.error('Failed to clear Gitea auth file:', error);
    return false;
  }
}

export const GITEA_AUTH_FILE = STORAGE_FILE;
