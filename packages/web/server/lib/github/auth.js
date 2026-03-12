import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';

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
    console.error('Failed to read GitHub auth file:', error);
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

function resolveAccountId({ user, accessToken, accountId }) {
  if (typeof accountId === 'string' && accountId.trim()) {
    return accountId.trim();
  }
  if (user && typeof user.login === 'string' && user.login.trim()) {
    return user.login.trim();
  }
  if (user && typeof user.id === 'number') {
    return String(user.id);
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
  const user = entry.user && typeof entry.user === 'object'
    ? {
      login: typeof entry.user.login === 'string' ? entry.user.login : null,
      avatarUrl: typeof entry.user.avatarUrl === 'string' ? entry.user.avatarUrl : null,
      id: typeof entry.user.id === 'number' ? entry.user.id : null,
      name: typeof entry.user.name === 'string' ? entry.user.name : null,
      email: typeof entry.user.email === 'string' ? entry.user.email : null,
    }
    : null;

  const accountId = resolveAccountId({
    user,
    accessToken,
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
  });

  return {
    accessToken,
    scope: typeof entry.scope === 'string' ? entry.scope : '',
    tokenType: typeof entry.tokenType === 'string' ? entry.tokenType : 'bearer',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    user,
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

export function getGitHubAuth() {
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

export function getGitHubAuthAccounts() {
  const list = readAuthList();
  return list
    .filter((entry) => entry?.user && entry.accountId)
    .map((entry) => ({
      id: entry.accountId,
      user: entry.user,
      scope: entry.scope || '',
      current: Boolean(entry.current),
    }));
}

export function setGitHubAuth({ accessToken, scope, tokenType, user, accountId }) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('accessToken is required');
  }
  const normalizedUser = user && typeof user === 'object'
    ? {
      login: typeof user.login === 'string' ? user.login : undefined,
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : undefined,
      id: typeof user.id === 'number' ? user.id : undefined,
      name: typeof user.name === 'string' ? user.name : undefined,
      email: typeof user.email === 'string' ? user.email : undefined,
    }
    : undefined;

  const resolvedAccountId = resolveAccountId({
    user: normalizedUser,
    accessToken,
    accountId,
  });

  const list = readAuthList();
  const existingIndex = list.findIndex((entry) => entry.accountId === resolvedAccountId);
  const nextEntry = {
    accessToken,
    scope: typeof scope === 'string' ? scope : '',
    tokenType: typeof tokenType === 'string' ? tokenType : 'bearer',
    createdAt: Date.now(),
    user: normalizedUser || null,
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

export function activateGitHubAuth(accountId) {
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

export function clearGitHubAuth() {
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
    console.error('Failed to clear GitHub auth file:', error);
    return false;
  }
}

export function getGitHubClientId() {
  const raw = process.env.OPENCHAMBER_GITHUB_CLIENT_ID;
  const clientId = typeof raw === 'string' ? raw.trim() : '';
  if (clientId) return clientId;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubClientId === 'string' ? parsed.githubClientId.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_CLIENT_ID;
}

export function getGitHubScopes() {
  const raw = process.env.OPENCHAMBER_GITHUB_SCOPES;
  const fromEnv = typeof raw === 'string' ? raw.trim() : '';
  if (fromEnv) return fromEnv;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubScopes === 'string' ? parsed.githubScopes.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_SCOPES;
}

export const GITHUB_AUTH_FILE = STORAGE_FILE;
