import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { renameWithRetry, renameSyncWithRetry } from '../shared/atomic-rename.js';
import { isVaultReference } from '../environment/vault.js';
import { readBoundedFile, readBoundedFileSync } from '../shared/bounded-file-read.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const AUTH_VERSION = 2;

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';
export const GH_CLI_ACCOUNT_ID = 'gh-cli';

const exactKeys = (value, required, optional = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
const validText = (value) => isString(value) && value.length > 0 && value.trim() === value && !/[\0\r\n]/.test(value);
const invalidState = (cause) => Object.assign(new Error('GitHub auth storage is invalid', { cause }), {
  code: 'INVALID_GITHUB_AUTH',
});

// Read caps for the two files this module reads whole (design #1254, #1651).
// github-auth.json holds a handful of credentials whose schema caps neither
// their count nor their field lengths, so 1 MiB is generous headroom, not a
// schema bound. settings.json is one shared file with one cap, matching the
// 8 MiB the other settings readers use (#1615/#1631 precedent). A file over
// its cap, or a non-regular file such as a FIFO, is refused by the shared
// bounded reader instead of being buffered whole (or, for a FIFO, blocking
// the server on read).
const GITHUB_AUTH_FILE_MAX_BYTES = 1 * 1024 * 1024;
const SETTINGS_FILE_MAX_BYTES = 8 * 1024 * 1024;

// A bounded refusal enters each reader as a thrown non-ENOENT error with the
// bounded reader's code, so every caller's existing read-failure handling
// applies unchanged: the store propagates it as a read failure (never an
// empty state), the strict settings reader propagates it (never an
// empty-base rewrite, #907/#940), and the lenient settings reader's
// catch-all still answers {}.
const boundedReadError = (filePath, result) => Object.assign(
  new Error(result.reason === 'too-large'
    ? `${filePath} exceeds the ${result.limit}-byte read limit (size ${result.size}); refusing to read it whole`
    : `${filePath} is not a regular file; refusing to read it`),
  { code: result.code },
);

export function githubAccountId(userId) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#${userId}`;
}

export function githubCliAccountId(userId) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#cli:${userId}`;
}

const newCredentialId = () => `occred:v1:github:${randomUUID()}:r1`;
const emptyState = () => ({ version: AUTH_VERSION, activeCredentialId: null, credentials: [] });

function parseUser(value) {
  if (!isPlainObject(value) || !Number.isInteger(value.id) || !validText(value.login)
    || !exactKeys(value, ['id', 'login'], ['avatarUrl', 'name', 'email'])) throw invalidState();
  const user = { id: value.id, login: value.login };
  for (const key of ['avatarUrl', 'name', 'email']) {
    if (value[key] !== undefined && value[key] !== null && !isString(value[key])) throw invalidState();
    if (isString(value[key])) user[key] = value[key];
  }
  return user;
}

// A token account keeps its token, or, added from a vault, only the reference
// to it (`tokenReference`, op://…), read when the token is used.
const hasTokenOrReference = (value) => (Object.hasOwn(value, 'tokenReference')
  ? !Object.hasOwn(value, 'accessToken') && value.source === 'pat' && validText(value.tokenReference) && isVaultReference(value.tokenReference)
  : validText(value.accessToken));

function parseCredential(value) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'scope', 'tokenType',
      'createdAt', 'user', 'source', 'status',
    ], ['invalidReason', 'accessToken', 'tokenReference'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validText(value.providerUserId) || !hasTokenOrReference(value)
    || !isString(value.scope) || !validText(value.tokenType)
    || !Number.isFinite(value.createdAt) || value.createdAt < 0
    || !['oauth', 'pat'].includes(value.source) || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user);
  if (githubAccountId(user.id) !== value.providerUserId) throw invalidState();
  if (value.invalidReason !== undefined && !validText(value.invalidReason)) throw invalidState();
  if (value.status === 'valid' && value.invalidReason !== undefined) throw invalidState();
  return { ...value, user, accountId: value.credentialId, credentialRevision: value.revision };
}

function parseVersionTwo(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'activeCredentialId', 'credentials'])
    || value.version !== AUTH_VERSION || !Array.isArray(value.credentials)
    || (value.activeCredentialId !== null && !validText(value.activeCredentialId))) throw invalidState();
  const credentials = value.credentials.map(parseCredential);
  if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
  if (value.activeCredentialId !== null
    && !credentials.some((credential) => credential.credentialId === value.activeCredentialId)) throw invalidState();
  return { version: AUTH_VERSION, activeCredentialId: value.activeCredentialId, credentials };
}

function parseLegacyUser(value) {
  if (!isPlainObject(value) || !Number.isInteger(value.id) || !validText(value.login)) throw invalidState();
  const user = { id: value.id, login: value.login };
  for (const key of ['avatarUrl', 'name', 'email']) {
    if (value[key] !== undefined && value[key] !== null && !isString(value[key])) throw invalidState();
    if (isString(value[key])) user[key] = value[key];
  }
  return user;
}

function parseLegacyCredential(value) {
  if (!isPlainObject(value) || !validText(value.accessToken)) throw invalidState();
  const user = parseLegacyUser(value.user);
  const credentialId = githubAccountId(user.id);
  const status = value.status === 'invalid' ? 'invalid' : 'valid';
  const credential = {
    credentialId,
    revision: 1,
    providerUserId: credentialId,
    accessToken: value.accessToken,
    scope: isString(value.scope) ? value.scope : '',
    tokenType: validText(value.tokenType) ? value.tokenType : 'bearer',
    createdAt: Number.isFinite(value.createdAt) && value.createdAt >= 0 ? value.createdAt : 0,
    user,
    source: value.source === 'pat' ? 'pat' : 'oauth',
    status,
    accountId: credentialId,
    credentialRevision: 1,
    legacyCurrent: value.current === true,
  };
  if (status === 'invalid') credential.invalidReason = validText(value.invalidReason) ? value.invalidReason : 'unauthorized';
  return credential;
}

function migrateLegacy(value) {
  const raw = Array.isArray(value) ? value : [value];
  if (!raw.length) return emptyState();
  const selected = new Map();
  for (const credential of raw.map(parseLegacyCredential)) {
    const previous = selected.get(credential.providerUserId);
    if (!previous || credential.legacyCurrent
      || (!previous.legacyCurrent && credential.createdAt >= previous.createdAt)) selected.set(credential.providerUserId, credential);
  }
  const credentials = [...selected.values()];
  const current = credentials.find((credential) => credential.legacyCurrent)
    ?? credentials.find((credential) => credential.status === 'valid')
    ?? credentials[0];
  for (const credential of credentials) delete credential.legacyCurrent;
  return { version: AUTH_VERSION, activeCredentialId: current?.credentialId ?? null, credentials };
}

function serializeState(state) {
  return {
    version: AUTH_VERSION,
    activeCredentialId: state.activeCredentialId,
    credentials: state.credentials.map((credential) => {
      const stored = {
        credentialId: credential.credentialId,
        revision: credential.revision,
        providerUserId: credential.providerUserId,
        scope: credential.scope,
        tokenType: credential.tokenType,
        createdAt: credential.createdAt,
        user: credential.user,
        source: credential.source,
        status: credential.status,
      };
      if (credential.tokenReference) stored.tokenReference = credential.tokenReference;
      else stored.accessToken = credential.accessToken;
      if (credential.status === 'invalid') stored.invalidReason = credential.invalidReason;
      return stored;
    }),
  };
}

function publicCredential(credential, state) {
  const userHasValidCredential = state.credentials.some((candidate) => (
    candidate.providerUserId === credential.providerUserId && candidate.status === 'valid'
  ));
  const view = {
    id: credential.credentialId,
    credentialId: credential.credentialId,
    credentialRevision: credential.revision,
    providerUserId: credential.providerUserId,
    providerUserStatus: userHasValidCredential ? 'available' : 'unavailable',
    user: credential.user,
    scope: credential.scope,
    current: state.activeCredentialId === credential.credentialId,
    source: credential.source,
    status: credential.status,
  };
  // Where the token is kept, not the token.
  if (credential.tokenReference) view.tokenReference = credential.tokenReference;
  return view;
}

/** @public Exposed to integration tests that dynamically import the auth module. */
export function createGitHubAuthStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 } = {}) {
  if (!validText(filePath)) throw new TypeError('GitHub auth file path is required');
  let transactions = Promise.resolve();
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(serializeState(state), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await renameWithRetry((from, to) => fsImpl.rename(from, to), temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const readState = async () => {
    const result = await readBoundedFile(filePath, GITHUB_AUTH_FILE_MAX_BYTES);
    if (!result.ok) {
      if (result.reason === 'missing') return emptyState();
      throw boundedReadError(filePath, result);
    }
    const encoded = result.buffer.toString('utf8');
    let value;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    if (isPlainObject(value) && Object.hasOwn(value, 'version')) return parseVersionTwo(value);
    const migrated = migrateLegacy(value);
    await writeState(migrated);
    return migrated;
  };
  const transaction = (operation) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    transactions = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = (operation) => transaction(async () => operation(await readState()));
  const mutate = (operation) => transaction(async () => {
    const state = await readState();
    const result = operation(state);
    if (result.changed) await writeState(state);
    return result.value;
  });
  const chooseActive = (state) => {
    const current = state.credentials.find((credential) => credential.credentialId === state.activeCredentialId);
    if (current?.status === 'valid') return;
    state.activeCredentialId = state.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? state.credentials[0]?.credentialId
      ?? null;
  };

  return Object.freeze({
    getActive: () => read((state) => {
      const credential = state.credentials.find((candidate) => candidate.credentialId === state.activeCredentialId);
      return credential?.status === 'valid' ? credential : null;
    }),
    listAccounts: () => read((state) => state.credentials.map((credential) => publicCredential(credential, state))),
    readAccount: (credentialId, revision) => read((state) => {
      const credential = state.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential || credential.status !== 'valid'
        || (revision !== undefined && credential.revision !== revision)) return null;
      return credential;
    }),
    setAccount: ({ accessToken, tokenReference, scope, tokenType, user, source = 'oauth' }) => mutate((state) => {
      const fromVault = tokenReference !== undefined;
      if (fromVault
        ? (source !== 'pat' || !isVaultReference(tokenReference) || accessToken !== undefined)
        : (!validText(accessToken) || !['oauth', 'pat'].includes(source))) throw new Error('Valid GitHub credential is required');
      const parsedUser = parseLegacyUser(user);
      const providerUserId = githubAccountId(parsedUser.id);
      const credentialId = newCredentialId();
      const credential = {
        credentialId,
        accountId: credentialId,
        revision: 1,
        credentialRevision: 1,
        providerUserId,
        ...(fromVault ? { tokenReference: tokenReference.trim() } : { accessToken }),
        scope: isString(scope) ? scope : '',
        tokenType: validText(tokenType) ? tokenType : 'bearer',
        createdAt: Date.now(),
        user: parsedUser,
        source,
        status: 'valid',
      };
      state.credentials.push(credential);
      state.activeCredentialId = credentialId;
      return { changed: true, value: credential };
    }),
    activate: (credentialId) => mutate((state) => {
      const credential = state.credentials.find((candidate) => candidate.credentialId === credentialId && candidate.status === 'valid');
      if (!credential) return { changed: false, value: false };
      if (state.activeCredentialId === credentialId) return { changed: false, value: true };
      state.activeCredentialId = credentialId;
      return { changed: true, value: true };
    }),
    markInvalid: (credentialId, reason = 'unauthorized') => mutate((state) => {
      const credential = state.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential) return { changed: false, value: false };
      // A refused token from a vault is likely rotated there; the next read
      // picks up the new one, so the account stays usable.
      if (credential.tokenReference) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(state);
      return { changed: true, value: true };
    }),
    removeAccount: (credentialId) => mutate((state) => {
      const index = state.credentials.findIndex((candidate) => candidate.credentialId === credentialId);
      if (index < 0) return { changed: false, value: false };
      state.credentials.splice(index, 1);
      chooseActive(state);
      return { changed: true, value: true };
    }),
  });
}

const authStore = createGitHubAuthStore({ filePath: STORAGE_FILE });

function readSettingsFile() {
  try {
    const result = readBoundedFileSync(SETTINGS_FILE, SETTINGS_FILE_MAX_BYTES);
    if (!result.ok) return {};
    return JSON.parse(result.buffer.toString('utf8')) || {};
  } catch {}
  return {};
}

// No parse error is attached: a JSON.parse error can quote the file, and
// settings.json holds user settings and secrets.
const invalidSettings = () => Object.assign(
  new Error(`${SETTINGS_FILE} is not valid JSON. Fix or move it before saving; refusing to overwrite it.`),
  { code: 'MALFORMED_SETTINGS' },
);

// Strict read for write paths (the linear/auth.js readSettingsForUpdate rule,
// #907): a write built on a malformed settings.json would rewrite the whole
// shared file from an empty base and erase every other setting. Missing and
// empty files read as {} (the first-run case); malformed files and non-object
// documents throw, and any other read failure propagates — a writer that
// cannot see the current contents must not replace them. Read-only callers
// keep the lenient readSettingsFile above.
function readSettingsFileForUpdate() {
  const result = readBoundedFileSync(SETTINGS_FILE, SETTINGS_FILE_MAX_BYTES);
  if (!result.ok) {
    if (result.reason === 'missing') return {};
    throw boundedReadError(SETTINGS_FILE, result);
  }
  const raw = result.buffer.toString('utf8');
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw invalidSettings();
  }
  if (!isPlainObject(parsed)) throw invalidSettings();
  return parsed;
}

function writeSettingsFile(settings) {
  fsSync.mkdirSync(STORAGE_DIR, { recursive: true });
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fsSync.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSyncWithRetry((from, to) => fsSync.renameSync(from, to), tmpFile, SETTINGS_FILE);
}

// Reads a vault reference's secret (`readSecret` of ../environment/vault.js),
// set once by the server. Without it an account added from a vault has no
// token, and reads as disconnected.
let readVaultSecret = null;

/** The server's vault reader, for accounts that keep a token reference. */
export const configureGitHubVaultReader = (reader) => {
  readVaultSecret = reader;
};

/**
 * The credential with the token filled in from its vault reference. A token
 * that cannot be read leaves `accessToken` out, as for an account with no
 * token, and names why in `tokenReadError`; the stored credential is unchanged.
 */
const withVaultToken = async (credential) => {
  if (!credential?.tokenReference) return credential;
  const outcome = readVaultSecret ? await readVaultSecret(credential.tokenReference) : { ok: false, reason: 'vault-unavailable' };
  return outcome.ok
    ? { ...credential, accessToken: outcome.value }
    : { ...credential, tokenReadError: outcome.reason };
};

/** A vault reference's token, for checking it before an account keeps the reference. */
export const readGitHubVaultToken = (reference) => (readVaultSecret
  ? readVaultSecret(reference)
  : Promise.resolve({ ok: false, reason: 'vault-unavailable' }));

export const getGitHubAuth = async () => withVaultToken(await authStore.getActive());
export const getGitHubAuthAccounts = () => authStore.listAccounts();
export const getGitHubAuthByAccountId = async (credentialId, revision) => withVaultToken(await authStore.readAccount(credentialId, revision));

export async function setGitHubAuth({ accessToken, tokenReference, scope, tokenType, user, accountId, source = 'oauth' }) {
  if (accountId !== undefined) throw new Error('GitHub credential IDs are server assigned');
  const credential = await authStore.setAccount({ accessToken, tokenReference, scope, tokenType, user, source });
  // A newly connected account becomes current, so the gh CLI stops being it.
  if (readSettingsFile().ghCliActive) setGhCliActive(false);
  return credential;
}

export async function activateGitHubAuth(credentialId) {
  const activated = await authStore.activate(credentialId);
  // Switching to a saved account is switching away from the gh CLI login.
  if (activated && readSettingsFile().ghCliActive) setGhCliActive(false);
  return activated;
}
export const markGitHubAuthAccountInvalid = (credentialId, reason = 'unauthorized') => authStore.markInvalid(credentialId, reason);
export const removeGitHubAuthAccount = (credentialId) => authStore.removeAccount(credentialId);

export function getGitHubClientId() {
  const raw = process.env.OPENCHAMBER_GITHUB_CLIENT_ID;
  const clientId = isString(raw) ? raw.trim() : '';
  if (clientId) return clientId;
  const stored = readSettingsFile()?.githubClientId;
  return isString(stored) && stored.trim() ? stored.trim() : DEFAULT_GITHUB_CLIENT_ID;
}

export function getGitHubScopes() {
  const raw = process.env.OPENCHAMBER_GITHUB_SCOPES;
  const fromEnv = isString(raw) ? raw.trim() : '';
  if (fromEnv) return fromEnv;
  const stored = readSettingsFile()?.githubScopes;
  return isString(stored) && stored.trim() ? stored.trim() : DEFAULT_GITHUB_SCOPES;
}

export const GITHUB_AUTH_FILE = STORAGE_FILE;

export function isGhCliDisabled() {
  return Boolean(readSettingsFile()?.ghCliDisabled);
}

export function setGhCliDisabled(disabled) {
  const settings = readSettingsFileForUpdate();
  settings.ghCliDisabled = Boolean(disabled);
  if (settings.ghCliDisabled) settings.ghCliActive = false;
  writeSettingsFile(settings);
}

export function isGhCliActive() {
  const settings = readSettingsFile();
  return !settings?.ghCliDisabled && Boolean(settings?.ghCliActive);
}

export function setGhCliActive(active) {
  const settings = readSettingsFileForUpdate();
  settings.ghCliActive = Boolean(active) && !settings.ghCliDisabled;
  writeSettingsFile(settings);
}
