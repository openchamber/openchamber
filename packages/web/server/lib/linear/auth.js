import fs from 'fs';
import path from 'path';
import os from 'os';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { isVaultReference } from '../environment/vault.js';
import { isPlainObject, readEnv, readFiniteNumber, readTrimmedString } from './parse.js';

const DEFAULT_LINEAR_CLIENT_ID = '91bbe26a69a2c8568d3683f1e01e776c';
const DEFAULT_LINEAR_SCOPES = 'read,write,comments:create';
const DEFAULT_LINEAR_BROKER_URL = 'https://api.openchamber.dev/v1/oauth/linear';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const LEGACY_WORKSPACE_ID = 'legacy';
const SESSION_COMMENTS_SETTING_KEY = 'linearSessionComments';

// Per-file caps for the bounded strict read below: linear-auth.json holds
// workspace credentials and stays small; the shared settings.json is a
// broader legacy/settings document, so it gets a distinct larger cap. A
// file over its cap is refused (MALFORMED), never buffered whole.
const LINEAR_AUTH_FILE_MAX_BYTES = 4 * 1024 * 1024;
const SETTINGS_FILE_MAX_BYTES = 8 * 1024 * 1024;

function resolveDataDir() {
  const fromEnv = readEnv('OPENCHAMBER_DATA_DIR');
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function storageFile() {
  return path.join(resolveDataDir(), 'linear-auth.json');
}

function settingsFile() {
  return path.join(resolveDataDir(), 'settings.json');
}

function ensureStorageDir() {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class LinearAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LinearAuthError';
    this.code = code;
  }
}

function malformedFileError(filePath) {
  // No parse error is attached or logged: a JSON.parse error can quote the
  // file, and these files hold tokens and user settings.
  return new LinearAuthError(
    `${filePath} is not valid JSON. Fix or move it before saving; refusing to overwrite it.`,
    'MALFORMED',
  );
}

// Strict read: missing and empty files read as null (the first-run case),
// malformed files throw MALFORMED, and any other read failure (permissions,
// I/O) propagates - a caller that cannot see the current contents must not
// replace them. Used by every write path, via the *ForUpdate readers below.
// The read goes through the shared bounded reader (design #1254): a file
// over its per-file cap, or a non-regular file such as a FIFO, maps to the
// same MALFORMED refusal instead of being buffered whole (or, for a FIFO,
// blocking the server on read). Unexpected I/O errors from the bounded
// reader still propagate unchanged.
function readJsonFileStrict(filePath, maxBytes) {
  const result = readBoundedFileSync(filePath, maxBytes);
  if (!result.ok) {
    if (result.reason === 'missing') {
      return null;
    }
    throw malformedFileError(filePath);
  }
  const raw = result.buffer.toString('utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw malformedFileError(filePath);
  }
  if (!isPlainObject(parsed)) {
    throw malformedFileError(filePath);
  }
  return parsed;
}

function jsonFileState(filePath, maxBytes) {
  try {
    return readJsonFileStrict(filePath, maxBytes) === null ? 'missing' : 'valid';
  } catch (error) {
    if (error instanceof LinearAuthError && error.code === 'MALFORMED') {
      return 'malformed';
    }
    return 'unreadable';
  }
}

// Whether the on-disk Linear files are usable, for status/diagnostic
// callers: a malformed file reads as not-connected through the lenient
// readers below, and this is how that case stays distinguishable from a
// file that was never written.
export function getLinearStorageState() {
  return {
    authFile: jsonFileState(storageFile(), LINEAR_AUTH_FILE_MAX_BYTES),
    settingsFile: jsonFileState(settingsFile(), SETTINGS_FILE_MAX_BYTES),
  };
}

// Lenient read for read-only paths: they keep answering on a malformed
// file (as empty / not connected) instead of throwing, exactly as before.
// The destructive conflation was only ever on the write side: writers
// built a replacement on this empty base and erased what the file held.
// Writers therefore never use this reader - see readJsonFileStrict.
function readJsonFile(filePath, maxBytes) {
  try {
    return readJsonFileStrict(filePath, maxBytes);
  } catch (error) {
    if (error instanceof LinearAuthError) {
      console.error('Failed to read Linear auth file:', error.message);
    } else if (error?.code !== 'ENOENT') {
      console.error('Failed to read Linear auth file:', error);
    }
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureStorageDir();
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function normalizeUser(user) {
  if (!isPlainObject(user)) {
    return null;
  }
  const id = readTrimmedString(user.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: readTrimmedString(user.name) || null,
    displayName: readTrimmedString(user.displayName) || null,
    email: readTrimmedString(user.email) || null,
    avatarUrl: readTrimmedString(user.avatarUrl) || null,
  };
}

function normalizeOrganization(organization) {
  if (!isPlainObject(organization)) {
    return null;
  }
  const id = readTrimmedString(organization.id);
  const name = readTrimmedString(organization.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    urlKey: readTrimmedString(organization.urlKey) || null,
  };
}

function resolveLinearWorkspaceId({ organization, user, workspaceId } = {}) {
  const explicit = readTrimmedString(workspaceId);
  if (explicit) return explicit;
  const organizationId = organization ? readTrimmedString(organization.id) : '';
  if (organizationId) return organizationId;
  const userId = user ? readTrimmedString(user.id) : '';
  if (userId) return `user:${userId}`;
  return LEGACY_WORKSPACE_ID;
}

function normalizeAuthEntry(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  // Two credential kinds (#304): OAuth entries hold an accessToken; vault
  // (apiKey) entries hold only a tokenReference (op://...) — the key itself
  // is resolved at call time and never written to this file (#176 pattern).
  const tokenReference = readTrimmedString(raw.tokenReference);
  const hasVaultReference = Boolean(tokenReference) && isVaultReference(tokenReference);
  const accessToken = readTrimmedString(raw.accessToken);
  if (!accessToken && !hasVaultReference) {
    return null;
  }
  const user = normalizeUser(raw.user);
  const organization = normalizeOrganization(raw.organization);
  return {
    accessToken: hasVaultReference ? null : accessToken,
    tokenReference: hasVaultReference ? tokenReference : null,
    source: hasVaultReference ? 'vault' : 'oauth',
    refreshToken: hasVaultReference ? null : (readTrimmedString(raw.refreshToken) || null),
    tokenType: hasVaultReference ? 'apiKey' : (readTrimmedString(raw.tokenType) || 'bearer'),
    expiresAt: readFiniteNumber(raw.expiresAt),
    scope: readTrimmedString(raw.scope),
    createdAt: readFiniteNumber(raw.createdAt),
    authorizedAt: readFiniteNumber(raw.authorizedAt) || readFiniteNumber(raw.createdAt),
    user,
    organization,
    current: Boolean(raw.current),
    workspaceId: resolveLinearWorkspaceId({
      organization,
      user,
      workspaceId: raw.workspaceId,
    }),
  };
}

function normalizeAuthList(raw) {
  const source = Array.isArray(raw?.workspaces)
    ? raw.workspaces
    : ((raw?.accessToken || raw?.tokenReference) ? [raw] : []);
  const list = source.map((entry) => normalizeAuthEntry(entry)).filter(Boolean);

  if (!list.length) {
    return { list: [], changed: Boolean(raw && (raw.accessToken || raw.tokenReference || Array.isArray(raw.workspaces))) };
  }

  let changed = Array.isArray(raw?.workspaces) === false && Boolean(raw?.accessToken || raw?.tokenReference);
  const seen = new Set();
  const deduped = [];
  for (const entry of list) {
    if (seen.has(entry.workspaceId)) {
      changed = true;
      continue;
    }
    seen.add(entry.workspaceId);
    deduped.push(entry);
  }

  let currentFound = false;
  deduped.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && deduped[0]) {
    deduped[0].current = true;
    changed = true;
  }

  return { list: deduped, changed };
}

function readAuthList() {
  const data = readJsonFile(storageFile(), LINEAR_AUTH_FILE_MAX_BYTES);
  if (!data) {
    return [];
  }
  const { list, changed } = normalizeAuthList(data);
  if (changed) {
    writeAuthList(list);
  }
  return list;
}

// The base for a write must be read strictly: a malformed auth file is
// never an empty base, so set/activate/clear refuse (MALFORMED) with the
// original bytes untouched instead of erasing every stored token.
function readAuthListForUpdate() {
  const data = readJsonFileStrict(storageFile(), LINEAR_AUTH_FILE_MAX_BYTES);
  if (!data) {
    return [];
  }
  return normalizeAuthList(data).list;
}

function writeAuthList(list) {
  if (!list.length) {
    const filePath = storageFile();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  writeJsonFile(storageFile(), { workspaces: list });
}

function readSettings() {
  return readJsonFile(settingsFile(), SETTINGS_FILE_MAX_BYTES) || {};
}

// Same rule for the shared settings.json: a write built on a malformed
// file would rewrite the whole file from an empty base.
function readSettingsForUpdate() {
  return readJsonFileStrict(settingsFile(), SETTINGS_FILE_MAX_BYTES) || {};
}

function writeSettings(settings) {
  writeJsonFile(settingsFile(), settings);
}

function readSettingString(key) {
  const stored = readSettings()[key];
  return readTrimmedString(stored);
}

export function getLinearAuth() {
  const list = readAuthList();
  if (!list.length) {
    return null;
  }
  return list.find((entry) => entry.current) || list[0];
}

export function getLinearAuthByWorkspaceId(workspaceId) {
  const id = readTrimmedString(workspaceId);
  if (!id) {
    return getLinearAuth();
  }
  return readAuthList().find((entry) => entry.workspaceId === id) || null;
}

export function getLinearAuthWorkspaces() {
  return readAuthList().map((entry) => ({
    id: entry.workspaceId,
    name: entry.organization?.name || null,
    urlKey: entry.organization?.urlKey || null,
    current: Boolean(entry.current),
    source: entry.tokenReference ? 'vault' : 'oauth',
    user: entry.user || null,
    authorizedAt: entry.authorizedAt || entry.createdAt || null,
  }));
}

// Reads a vault reference's secret (`readSecret` of
// ../environment/vault.js), set once by the server. Without it an account
// added from a vault cannot be resolved and reads as unusable.
let readVaultSecret = null;

/** The server's vault reader, for accounts that keep a token reference. */
export const configureLinearVaultReader = (reader) => {
  readVaultSecret = reader;
};

/** A vault reference's key, for checking it before an account keeps the reference. */
export const readLinearVaultToken = (reference) => (readVaultSecret
  ? readVaultSecret(reference)
  : Promise.resolve({ ok: false, reason: 'vault-unavailable' }));

export function setLinearAuth(input, options = {}) {
  const tokenReference = readTrimmedString(input?.tokenReference);
  if (tokenReference && !isVaultReference(tokenReference)) {
    throw new Error('tokenReference must be a valid 1Password reference (op://...)');
  }
  const accessToken = readTrimmedString(input?.accessToken);
  if (tokenReference && accessToken) {
    throw new Error('accessToken and tokenReference are mutually exclusive');
  }
  if (!accessToken && !tokenReference) {
    throw new Error('accessToken is required');
  }
  const activate = options.activate !== false;
  const list = readAuthListForUpdate();
  const current = list.find((entry) => entry.current) || list[0] || null;

  const nextUser = Object.prototype.hasOwnProperty.call(input, 'user')
    ? normalizeUser(input.user)
    : current?.user || null;
  const nextOrganization = Object.prototype.hasOwnProperty.call(input, 'organization')
    ? normalizeOrganization(input.organization)
    : current?.organization || null;
  const workspaceId = resolveLinearWorkspaceId({
    organization: nextOrganization,
    user: nextUser,
    workspaceId: input?.workspaceId || (nextOrganization || nextUser ? '' : current?.workspaceId),
  });

  const existingIndex = list.findIndex((entry) => entry.workspaceId === workspaceId);
  const previous = existingIndex >= 0 ? list[existingIndex] : (
    nextOrganization || nextUser ? null : current
  );
  const targetIndex = existingIndex >= 0
    ? existingIndex
    : (previous && !nextOrganization && !nextUser ? list.indexOf(previous) : -1);
  const wasCurrent = previous?.current === true;

  const next = {
    accessToken: tokenReference ? null : accessToken,
    tokenReference: tokenReference || null,
    source: tokenReference ? 'vault' : 'oauth',
    refreshToken: tokenReference
      ? null
      : (Object.prototype.hasOwnProperty.call(input, 'refreshToken')
        ? (readTrimmedString(input.refreshToken) || null)
        : previous?.refreshToken || null),
    tokenType: tokenReference ? 'apiKey' : (readTrimmedString(input?.tokenType) || previous?.tokenType || 'bearer'),
    expiresAt: tokenReference ? null : (readFiniteNumber(input?.expiresAt) ?? previous?.expiresAt ?? null),
    scope: tokenReference ? '' : (readTrimmedString(input?.scope) || previous?.scope || ''),
    createdAt: previous?.createdAt || Date.now(),
    authorizedAt: Object.prototype.hasOwnProperty.call(input, 'authorizedAt')
      ? (readFiniteNumber(input.authorizedAt) || Date.now())
      : (activate ? Date.now() : (previous?.authorizedAt || previous?.createdAt || Date.now())),
    user: nextUser,
    organization: nextOrganization,
    current: false,
    workspaceId,
  };

  if (targetIndex >= 0) {
    list[targetIndex] = next;
  } else {
    list.push(next);
  }

  const writtenIndex = targetIndex >= 0 ? targetIndex : list.length - 1;
  if (activate || !list.some((entry) => entry.current)) {
    list.forEach((entry, index) => {
      entry.current = index === writtenIndex;
    });
  } else {
    list[writtenIndex].current = wasCurrent;
  }

  writeAuthList(list);
  return list[writtenIndex];
}

export function activateLinearAuth(workspaceId) {
  const id = readTrimmedString(workspaceId);
  if (!id) {
    return false;
  }
  const list = readAuthListForUpdate();
  const index = list.findIndex((entry) => entry.workspaceId === id);
  if (index === -1) {
    return false;
  }
  list.forEach((entry, idx) => {
    entry.current = idx === index;
  });
  writeAuthList(list);
  return true;
}

export function clearLinearAuth(workspaceId) {
  try {
    const list = readAuthListForUpdate();
    if (!list.length) {
      return true;
    }
    const id = readTrimmedString(workspaceId);
    const remaining = id
      ? list.filter((entry) => entry.workspaceId !== id)
      : list.filter((entry) => !entry.current);
    if (!remaining.length) {
      writeAuthList([]);
      return true;
    }
    if (!remaining.some((entry) => entry.current)) {
      remaining[0].current = true;
    }
    writeAuthList(remaining);
    return true;
  } catch (error) {
    console.error('Failed to clear Linear auth file:', error);
    return false;
  }
}

export function isLinearAccessTokenStale(expiresAt, now = Date.now()) {
  const expiry = readFiniteNumber(expiresAt);
  if (expiry == null) {
    return true;
  }
  return expiry - ACCESS_TOKEN_REFRESH_SKEW_MS <= now;
}

export function toLinearPublicStatus(auth, workspaces = getLinearAuthWorkspaces()) {
  if (!auth?.accessToken && !auth?.tokenReference) {
    if (getLinearStorageState().authFile === 'malformed') {
      return { connected: false, code: 'MALFORMED', error: malformedFileError(storageFile()).message };
    }
    return { connected: false };
  }
  return {
    connected: true,
    source: auth.tokenReference ? 'vault' : 'oauth',
    user: auth.user || null,
    organization: auth.organization || null,
    scope: auth.scope || undefined,
    workspaces,
  };
}

export function getLinearClientId() {
  const fromEnv = readEnv('OPENCHAMBER_LINEAR_CLIENT_ID');
  if (fromEnv) return fromEnv;
  const stored = readSettingString('linearClientId');
  if (stored) return stored;
  return DEFAULT_LINEAR_CLIENT_ID;
}

export function getLinearClientSecret() {
  const fromEnv = readEnv('OPENCHAMBER_LINEAR_CLIENT_SECRET');
  if (fromEnv) return fromEnv;
  return readSettingString('linearClientSecret');
}

export function getLinearScopes() {
  const fromEnv = readEnv('OPENCHAMBER_LINEAR_SCOPES');
  if (fromEnv) return fromEnv;
  const stored = readSettingString('linearScopes');
  if (stored) return stored;
  return DEFAULT_LINEAR_SCOPES;
}

export function getLinearBrokerUrl() {
  const fromEnv = readEnv('OPENCHAMBER_LINEAR_BROKER_URL');
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const stored = readSettingString('linearBrokerUrl');
  if (stored) return stored.replace(/\/+$/, '');
  return DEFAULT_LINEAR_BROKER_URL;
}

export function getLinearRedirectUri() {
  const fromEnv = readEnv('OPENCHAMBER_LINEAR_REDIRECT_URI');
  if (fromEnv) return fromEnv;
  const stored = readSettingString('linearRedirectUri');
  if (stored) return stored;
  return `${getLinearBrokerUrl()}/callback`;
}

/**
 * Status comments are opt-in: they are written into a Linear workspace other
 * people read, so nothing is posted until the user turns them on.
 */
export function getLinearSessionCommentsEnabled() {
  return readSettings()[SESSION_COMMENTS_SETTING_KEY] === true;
}

export function setLinearSessionCommentsEnabled(enabled) {
  const next = enabled === true;
  const settings = readSettingsForUpdate();
  settings[SESSION_COMMENTS_SETTING_KEY] = next;
  writeSettings(settings);
  return next;
}

export function getLinearAuthFilePath() {
  return storageFile();
}
export const DEFAULT_LINEAR_CLIENT_ID_VALUE = DEFAULT_LINEAR_CLIENT_ID;
