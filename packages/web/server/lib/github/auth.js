import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
// GitHub Enterprise instances keep their own credentials in the server token
// store GitLab uses, one entry per host; this file stays github.com's own. The
// github.com instance (device flow and accounts) keeps living here. The path is
// resolved at call time (not module load) so the caller's OPENCHAMBER_DATA_DIR
// at that moment wins even when the module was imported earlier in the process.
const sourceControlAuthStoreFilePath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'source-control-auth.json',
);
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
// Version 3 holds one entry per instance. Version 2 was a flat github.com-only
// list. github.com's device-flow accounts stay in this file; a GitHub
// Enterprise host's personal access tokens live in the shared
// `source-control-auth.json` next to GitLab's (`createSourceControlAuthStore`),
// and the host-scoped accessors below route non-github.com hosts there.
const AUTH_VERSION = 3;

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

function githubAccountId(userId) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#${userId}`;
}

export function githubCliAccountId(userId) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#cli:${userId}`;
}

// A host key is always a normalized hostname; an omitted/empty host is
// github.com, the only instance the device flow can serve.
const normalizeInstance = (host) => {
  const value = String(host ?? '').trim().toLowerCase();
  return value ? value : 'github.com';
};
const providerUserIdFor = (host, userId) => `${normalizeInstance(host)}#${userId}`;
const newCredentialId = () => `occred:v1:github:${randomUUID()}:r1`;
const emptyState = () => ({ version: AUTH_VERSION, instances: {} });
const emptyInstance = () => ({ activeCredentialId: null, credentials: [], cliDisabled: false, cliActive: false });

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

function parseCredential(value, host) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'accessToken', 'scope', 'tokenType',
      'createdAt', 'user', 'source', 'status',
    ], ['invalidReason'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validText(value.providerUserId) || !validText(value.accessToken)
    || !isString(value.scope) || !validText(value.tokenType)
    || !Number.isFinite(value.createdAt) || value.createdAt < 0
    || !['oauth', 'pat'].includes(value.source) || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserIdFor(host, user.id) !== value.providerUserId) throw invalidState();
  if (value.invalidReason !== undefined && !validText(value.invalidReason)) throw invalidState();
  if (value.status === 'valid' && value.invalidReason !== undefined) throw invalidState();
  return { ...value, user, accountId: value.credentialId, credentialRevision: value.revision };
}

function parseInstance(rawInstance) {
  if (!isPlainObject(rawInstance)
    || !exactKeys(rawInstance, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'])
    || (rawInstance.activeCredentialId !== null && !validText(rawInstance.activeCredentialId))
    || !Array.isArray(rawInstance.credentials)
    || Object.prototype.toString.call(rawInstance.cliDisabled) !== '[object Boolean]'
    || Object.prototype.toString.call(rawInstance.cliActive) !== '[object Boolean]'
    || (rawInstance.cliDisabled && rawInstance.cliActive)) throw invalidState();
  return rawInstance;
}

function parseVersionThree(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'instances'])
    || value.version !== AUTH_VERSION || !isPlainObject(value.instances)) throw invalidState();
  const state = emptyState();
  for (const [rawHost, rawInstance] of Object.entries(value.instances)) {
    const host = normalizeInstance(rawHost);
    if (!validText(rawHost) || host !== rawHost || !isPlainObject(rawInstance)) throw invalidState();
    const credentials = rawInstance.credentials.map((credential) => parseCredential(credential, host));
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
    if (rawInstance.activeCredentialId !== null
      && !credentials.some((credential) => credential.credentialId === rawInstance.activeCredentialId)) throw invalidState();
    state.instances[host] = {
      activeCredentialId: rawInstance.activeCredentialId,
      credentials,
      cliDisabled: rawInstance.cliDisabled,
      cliActive: rawInstance.cliActive,
    };
  }
  return state;
}

// Version 2 was the flat github.com-only shape `{ version: 2, activeCredentialId,
// credentials }`. It migrates into the github.com instance so existing files
// keep their credentials with the same ids and secrets.
function parseVersionTwo(value) {
  const { version: _version, ...flatValue } = value;
  const flat = parseInstance({ ...flatValue, cliDisabled: false, cliActive: false });
  return { version: AUTH_VERSION, instances: {
    'github.com': {
      ...flat,
      credentials: flat.credentials.map((credential) => parseCredential(credential, 'github.com')),
    },
  } };
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
  const instance = { activeCredentialId: current?.credentialId ?? null, credentials, cliDisabled: false, cliActive: false };
  return { version: AUTH_VERSION, instances: { 'github.com': instance } };
}

const serializeCredential = (credential) => {
  const stored = {
    credentialId: credential.credentialId,
    revision: credential.revision,
    providerUserId: credential.providerUserId,
    accessToken: credential.accessToken,
    scope: credential.scope,
    tokenType: credential.tokenType,
    createdAt: credential.createdAt,
    user: credential.user,
    source: credential.source,
    status: credential.status,
  };
  if (credential.status === 'invalid') stored.invalidReason = credential.invalidReason;
  return stored;
};

// Earlier releases read only the flat version 2 shape, so a file that holds
// nothing beyond github.com accounts is written that way; version 3 appears
// once another host, or a gh switch the flat shape cannot hold, is stored.
const fitsVersionTwo = (state) => Object.keys(state.instances).every((host) => host === 'github.com')
  && !state.instances['github.com']?.cliDisabled && !state.instances['github.com']?.cliActive;

function serializeState(state) {
  if (fitsVersionTwo(state)) {
    const instance = state.instances['github.com'];
    return {
      version: 2,
      activeCredentialId: instance?.activeCredentialId ?? null,
      credentials: (instance?.credentials ?? []).map(serializeCredential),
    };
  }
  const instances = {};
  for (const [host, instance] of Object.entries(state.instances)) {
    instances[host] = {
      activeCredentialId: instance.activeCredentialId,
      credentials: instance.credentials.map((credential) => {
        const stored = {
          credentialId: credential.credentialId,
          revision: credential.revision,
          providerUserId: credential.providerUserId,
          accessToken: credential.accessToken,
          scope: credential.scope,
          tokenType: credential.tokenType,
          createdAt: credential.createdAt,
          user: credential.user,
          source: credential.source,
          status: credential.status,
        };
        if (credential.status === 'invalid') stored.invalidReason = credential.invalidReason;
        return stored;
      }),
      cliDisabled: instance.cliDisabled,
      cliActive: instance.cliActive,
    };
  }
  return { version: AUTH_VERSION, instances };
}

function publicCredential(credential, instance) {
  const userHasValidCredential = instance.credentials.some((candidate) => (
    candidate.providerUserId === credential.providerUserId && candidate.status === 'valid'
  ));
  return {
    id: credential.credentialId,
    credentialId: credential.credentialId,
    credentialRevision: credential.revision,
    providerUserId: credential.providerUserId,
    providerUserStatus: userHasValidCredential ? 'available' : 'unavailable',
    user: credential.user,
    scope: credential.scope,
    current: instance.activeCredentialId === credential.credentialId,
    source: credential.source,
    status: credential.status,
  };
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
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const readState = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    let value;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    if (isPlainObject(value) && Object.hasOwn(value, 'version')) {
      if (value.version === 2) return parseVersionTwo(value);
      return parseVersionThree(value);
    }
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
  const instanceOf = (state, host) => state.instances[normalizeInstance(host)] ?? emptyInstance();
  const chooseActive = (instance) => {
    const current = instance.credentials.find((credential) => credential.credentialId === instance.activeCredentialId);
    if (current?.status === 'valid') return;
    instance.activeCredentialId = instance.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? instance.credentials[0]?.credentialId
      ?? null;
  };
  const retainInstance = (instances, host, instance) => {
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive) delete instances[host];
    else instances[host] = instance;
  };
  const readAccountIn = (instance, credentialId, revision) => {
    const credential = instance.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (!credential || credential.status !== 'valid'
      || (revision !== undefined && credential.revision !== revision)) return null;
    return credential;
  };
  const hostMethods = {
    getActiveForHost: (host) => read((state) => {
      const instance = instanceOf(state, host);
      const credential = instance.credentials.find((candidate) => candidate.credentialId === instance.activeCredentialId);
      return credential?.status === 'valid' ? credential : null;
    }),
    listAccountsForHost: (host) => read((state) => instanceOf(state, host).credentials.map((credential) => publicCredential(credential, instanceOf(state, host)))),
    // Credential ids are unique across instances (server-assigned), so an opaque
    // credential id alone identifies its own instance. The returned record earns
    // a `host` so callers know which API root the token belongs to.
    readAccountAnyInstance: (credentialId, revision) => read((state) => {
      for (const [host, instance] of Object.entries(state.instances)) {
        const credential = readAccountIn(instance, credentialId, revision);
        if (credential) return { ...credential, host };
      }
      return null;
    }),
    setAccountForHost: (host, { accessToken, scope, tokenType, user, source = 'oauth' }) => mutate((state) => {
      if (!validText(accessToken) || !['oauth', 'pat'].includes(source)) throw new Error('Valid GitHub credential is required');
      const hostKey = normalizeInstance(host);
      const parsedUser = parseLegacyUser(user);
      const credentialId = newCredentialId();
      const instance = instanceOf(state, hostKey);
      const credential = {
        credentialId,
        accountId: credentialId,
        revision: 1,
        credentialRevision: 1,
        providerUserId: providerUserIdFor(hostKey, parsedUser.id),
        accessToken,
        scope: isString(scope) ? scope : '',
        tokenType: validText(tokenType) ? tokenType : 'bearer',
        createdAt: Date.now(),
        user: parsedUser,
        source,
        status: 'valid',
      };
      instance.credentials.push(credential);
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      state.instances[hostKey] = instance;
      return { changed: true, value: credential };
    }),
    activateForHost: (host, credentialId) => mutate((state) => {
      const instance = state.instances[normalizeInstance(host)];
      if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
        return { changed: false, value: false };
      }
      const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      state.instances[normalizeInstance(host)] = instance;
      return { changed, value: true };
    }),
    markInvalidForHost: (host, credentialId, reason = 'unauthorized') => mutate((state) => {
      const instance = state.instances[normalizeInstance(host)];
      const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(instance);
      return { changed: true, value: true };
    }),
    removeAccountForHost: (host, credentialId) => mutate((state) => {
      const instances = state.instances;
      const instance = instances[normalizeInstance(host)];
      const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
      if (index < 0) return { changed: false, value: false };
      instance.credentials.splice(index, 1);
      chooseActive(instance);
      retainInstance(instances, normalizeInstance(host), instance);
      return { changed: true, value: true };
    }),
    setCliDisabledForHost: (host, disabled) => mutate((state) => {
      const hostKey = normalizeInstance(host);
      const instance = instanceOf(state, hostKey);
      const nextDisabled = Boolean(disabled);
      const nextActive = nextDisabled ? false : instance.cliActive;
      const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive;
      instance.cliDisabled = nextDisabled;
      instance.cliActive = nextActive;
      retainInstance(state.instances, hostKey, instance);
      return { changed, value: instance.cliDisabled };
    }),
    setCliActiveForHost: (host, active) => mutate((state) => {
      const hostKey = normalizeInstance(host);
      const instance = instanceOf(state, hostKey);
      const nextActive = Boolean(active) && !instance.cliDisabled;
      const changed = instance.cliActive !== nextActive;
      instance.cliActive = nextActive;
      retainInstance(state.instances, hostKey, instance);
      return { changed, value: instance.cliActive };
    }),
  };

  return Object.freeze({
    ...hostMethods,
    // github.com shorthands kept for the account layer: a hostless call means github.com.
    listAccounts: () => hostMethods.listAccountsForHost('github.com'),
    setAccount: (args) => hostMethods.setAccountForHost('github.com', args),
    markInvalid: (credentialId, reason) => hostMethods.markInvalidForHost('github.com', credentialId, reason),
  });
}

const authStore = createGitHubAuthStore({ filePath: STORAGE_FILE });
// The server token store GitLab uses, read and written from here for GitHub
// Enterprise hosts: one entry per host, holding that host's personal access
// tokens and its gh CLI switch. Its file lock and this file's are the same
// `source-control-auth.json.lock`, so the desktop app and a web server share it
// the way GitLab's accounts do. A fresh store per call, so the shared token
// store's path — and therefore the OPENCHAMBER_DATA_DIR in effect at that
// moment — is the one that wins, even when this module was imported earlier in
// the same process; the github.com file and lock above keep module-load
// behavior exactly.
const instanceAuthStore = () => createSourceControlAuthStore({ filePath: sourceControlAuthStoreFilePath() });

function readSettingsFile() {
  try {
    if (fsSync.existsSync(SETTINGS_FILE)) return JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {}
  return {};
}

function writeSettingsFile(settings) {
  fsSync.mkdirSync(STORAGE_DIR, { recursive: true });
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fsSync.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fsSync.renameSync(tmpFile, SETTINGS_FILE);
}

const githubInstanceAccounts = async (host) => {
  const instance = await instanceAuthStore().github.readInstance(host);
  return instance.accounts.map((credential) => publicCredential(credential, { activeCredentialId: instance.activeAccountId, credentials: instance.accounts }));
};
const getActiveForHost = async (host) => {
  const instance = await instanceAuthStore().github.readInstance(host);
  if (!instance.activeAccountId) return null;
  return instanceAuthStore().github.readAccount(host, instance.activeAccountId);
};
// The active credential of one instance (github.com from github-auth.json, a
// named enterprise host from the shared server token store); caller-scoped per
// host, so github.com's OAuth token is never a candidate for another host.
export const getGitHubAuthForHost = (host) => (normalizeInstance(host) === 'github.com'
  ? authStore.getActiveForHost(host)
  : getActiveForHost(host));
export const getGitHubAuth = (host) => (normalizeInstance(host) === 'github.com'
  ? authStore.getActiveForHost(host)
  : getActiveForHost(host));
export const getGitHubAuthAccounts = () => authStore.listAccountsForHost('github.com');
export const getGitHubAuthAccountsForHost = async (host) => (normalizeInstance(host) === 'github.com'
  ? authStore.listAccountsForHost(host)
  : githubInstanceAccounts(host));
export const getGitHubAuthByAccountId = async (credentialId, revision) => {
  // Credential ids are server-assigned and opaque; github.com's live in
  // `github-auth.json`, a named enterprise host's in the shared token store.
  // Read the shared store first (the per-host path the GHE branch writes), then
  // the github.com file, so a per-instance PAT never falls through.
  const instanceCredential = await instanceAuthStore().github.readAccountAnyInstance(credentialId, revision);
  if (instanceCredential) return instanceCredential;
  return authStore.readAccountAnyInstance(credentialId, revision);
};

export async function setGitHubAuth({ accessToken, scope, tokenType, user, accountId, source = 'oauth' }) {
  if (accountId !== undefined) throw new Error('GitHub credential IDs are server assigned');
  const credential = await authStore.setAccount({ accessToken, scope, tokenType, user, source });
  // A newly connected account becomes current, so the gh CLI stops being it.
  if (readSettingsFile().ghCliActive) setGhCliActive(false);
  return credential;
}

export async function setGitHubAuthForHost(host, { accessToken, scope, tokenType, user, source = 'oauth' }) {
  const credential = normalizeInstance(host) === 'github.com'
    ? await authStore.setAccountForHost(host, { accessToken, scope, tokenType, user, source })
    : await instanceAuthStore().github.setAccount(host, { accessToken, scope, tokenType, user, source });
  // The gh CLI for that instance stops being active: a stored credential is the
  // preference until the instance's gh login is explicitly active again.
  if (normalizeInstance(host) === 'github.com' && readSettingsFile().ghCliActive) setGhCliActive(false);
  return credential;
}

export async function activateGitHubAuthForHost(host, credentialId) {
  const activated = normalizeInstance(host) === 'github.com'
    ? await authStore.activateForHost(host, credentialId)
    : await instanceAuthStore().github.activate(host, credentialId);
  if (activated && normalizeInstance(host) === 'github.com' && readSettingsFile().ghCliActive) setGhCliActive(false);
  return activated;
}
export const markGitHubAuthAccountInvalid = (credentialId, reason = 'unauthorized') => authStore.markInvalid(credentialId, reason);
export const markGitHubAuthAccountInvalidForHost = (host, credentialId, reason = 'unauthorized') => (normalizeInstance(host) === 'github.com'
  ? authStore.markInvalidForHost(host, credentialId, reason)
  : instanceAuthStore().github.markAccountInvalid(host, credentialId, reason));
export const removeGitHubAuthAccountForHost = (host, credentialId) => (normalizeInstance(host) === 'github.com'
  ? authStore.removeAccountForHost(host, credentialId)
  : instanceAuthStore().github.removeAccount(host, credentialId));

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

export function isGhCliDisabled() {
  return Boolean(readSettingsFile()?.ghCliDisabled);
}

export function setGhCliDisabled(disabled) {
  const settings = readSettingsFile();
  settings.ghCliDisabled = Boolean(disabled);
  if (settings.ghCliDisabled) settings.ghCliActive = false;
  writeSettingsFile(settings);
}

function isGhCliActive() {
  const settings = readSettingsFile();
  return !settings?.ghCliDisabled && Boolean(settings?.ghCliActive);
}

export function setGhCliActive(active) {
  const settings = readSettingsFile();
  settings.ghCliActive = Boolean(active) && !settings.ghCliDisabled;
  writeSettingsFile(settings);
}

// The gh CLI switch is per instance: github.com keeps its Settings switch; an
// enterprise host's gh login is used only after the user activated that instance.
// The per-instance switch lives in the shared server token store like GitLab's;
// github.com's lives in settings.json. The global `ghCliDisabled` is github.com's
// own switch only — it never kills another host's gh login, so turning one
// instance off cannot take the others with it.
export const isGhCliDisabledForHost = async (host) => {
  if (normalizeInstance(host) === 'github.com') return isGhCliDisabled();
  return (await instanceAuthStore().github.readInstance(host)).cliDisabled;
};

export const isGhCliActiveForHost = async (host) => {
  if (normalizeInstance(host) === 'github.com') return isGhCliActive();
  return (await instanceAuthStore().github.readInstance(host)).cliActive;
};

export const setGhCliDisabledForHost = (host, disabled) => (normalizeInstance(host) === 'github.com'
  ? setGhCliDisabled(disabled)
  : instanceAuthStore().github.setCliDisabled(host, disabled));

export const setGhCliActiveForHost = (host, active) => (normalizeInstance(host) === 'github.com'
  ? setGhCliActive(active)
  : instanceAuthStore().github.setCliActive(host, active));
