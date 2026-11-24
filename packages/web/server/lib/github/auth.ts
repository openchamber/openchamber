import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readSettingsFileForUpdateSync } from '../settings/settings-update-read.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { hasSourceControlErrorCode, isSourceControlFiniteNumber, isSourceControlInteger } from '../source-control/input-guards.js';
import type { AuthCredentialFields, AuthJson, AuthUser, GitHubAccountInput, GitHubCredential, GitHubCredentialInvalidation } from '../source-control/auth-storage.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const sourceControlAuthStoreFilePath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'source-control-auth.json',
);
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const AUTH_VERSION = 3;

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';
export const GH_CLI_ACCOUNT_ID = 'gh-cli';

type JsonObject = { [key: string]: AuthJson };
export type LocalCredential = GitHubCredential & { accountId: string; credentialRevision: number; legacyCurrent?: boolean };
interface LocalInstance {
  activeCredentialId: string | null;
  credentials: LocalCredential[];
  cliDisabled: AuthJson | undefined;
  cliActive: AuthJson | undefined;
  cliLogin?: AuthJson | undefined;
}
interface LocalState {
  version: number;
  instances: Record<string, LocalInstance>;
}
interface StoreOptions {
  filePath?: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
}
type SaveCredential = Omit<GitHubAccountInput, 'source'> & { source?: GitHubAccountInput['source'] };
type Settings = Partial<Record<'ghCliDisabled' | 'ghCliActive' | 'ghCliLogin' | 'githubClientId' | 'githubScopes', AuthJson>>;
type Host = string | null | undefined;
const isJsonObject = (value: AuthJson | undefined): value is JsonObject => isPlainObject(value);
const isJsonArray = (value: AuthJson | undefined): value is AuthJson[] => Array.isArray(value);
const isInteger = (value: AuthJson | undefined): value is number => Number.isInteger(value);
const isBooleanTag = (value: AuthJson | undefined): value is boolean => Object.prototype.toString.call(value) === '[object Boolean]';
const avatarFields = ['avatarUrl', 'name', 'email'] as const;

const exactKeys = (value: JsonObject, required: string[], optional: string[] = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
const validText = (value: AuthJson | undefined): value is string => isString(value) && value.length > 0 && value.trim() === value && !/[\0\r\n]/.test(value);
const invalidState = (cause?: ErrorOptions['cause']) => Object.assign(new Error('GitHub auth storage is invalid', { cause }), {
  code: 'INVALID_GITHUB_AUTH',
});

function githubAccountId(userId: number) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#${userId}`;
}

export function githubCliAccountId(userId: number) {
  if (!Number.isInteger(userId)) return '';
  return `github.com#cli:${userId}`;
}

const normalizeInstance = (host: GitHubErrorIdentity['instance']) => {
  const value = String(host ?? '').trim().toLowerCase();
  return value ? value : 'github.com';
};
const providerUserIdFor = (host: Host, userId: number | string) => `${normalizeInstance(host)}#${userId}`;
const newCredentialId = () => `occred:v1:github:${randomUUID()}:r1`;
const emptyState = (): LocalState => ({ version: AUTH_VERSION, instances: {} });
const emptyInstance = (): LocalInstance => ({ activeCredentialId: null, credentials: [], cliDisabled: false, cliActive: false, cliLogin: null });

function parseUser(value: AuthJson | undefined) {
  if (!isJsonObject(value) || !isInteger(value.id) || !validText(value.login)
    || !exactKeys(value, ['id', 'login'], ['avatarUrl', 'name', 'email'])) throw invalidState();
  const user: AuthUser = { id: value.id, login: value.login };
  for (const key of avatarFields) {
    const field = value[key];
    if (field !== undefined && field !== null && !isString(field)) throw invalidState();
    if (isString(field)) user[key] = field;
  }
  return user;
}

const sourceNames: ReadonlyArray<AuthJson | undefined> = ['oauth', 'pat'];
const statusNames: ReadonlyArray<AuthJson | undefined> = ['valid', 'invalid'];
const isCredentialSource = (value: AuthJson | undefined): value is GitHubCredential['source'] => sourceNames.includes(value);
const isCredentialStatus = (value: AuthJson | undefined): value is GitHubCredential['status'] => statusNames.includes(value);

type CredentialInput = Omit<GitHubCredential, 'user' | 'invalidReason'> & { user: AuthJson; invalidReason?: AuthJson };
const isCredentialInput = (value: AuthJson): value is CredentialInput => isJsonObject(value)
    && exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'accessToken', 'scope', 'tokenType',
      'createdAt', 'user', 'source', 'status',
    ], ['invalidReason'])
    && validText(value.credentialId) && isSourceControlInteger(value.revision) && value.revision >= 1
    && validText(value.providerUserId) && validText(value.accessToken)
    && isString(value.scope) && validText(value.tokenType)
    && isSourceControlFiniteNumber(value.createdAt) && value.createdAt >= 0
    && isCredentialSource(value.source) && isCredentialStatus(value.status);
const hasValidReason = (value: CredentialInput): value is CredentialInput & Pick<GitHubCredential, 'invalidReason'> =>
  (value.invalidReason === undefined || validText(value.invalidReason))
  && (value.status !== 'valid' || value.invalidReason === undefined);

function parseCredential(value: AuthJson, host: string): LocalCredential {
  if (!isCredentialInput(value)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserIdFor(host, user.id) !== value.providerUserId) throw invalidState();
  if (!hasValidReason(value)) throw invalidState();
  return { ...value, user, accountId: value.credentialId, credentialRevision: value.revision };
}

function parseInstance(rawInstance: JsonObject) {
  const validInstance = (value: JsonObject): value is JsonObject & {
    activeCredentialId: string | null; credentials: AuthJson[]; cliDisabled: boolean; cliActive: boolean;
  } => isPlainObject(value)
    && exactKeys(value, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'], ['cliLogin'])
    && (value.activeCredentialId === null || validText(value.activeCredentialId))
    && isJsonArray(value.credentials)
    && isBooleanTag(value.cliDisabled)
    && isBooleanTag(value.cliActive)
    && (value.cliLogin === undefined || value.cliLogin === null || validText(value.cliLogin))
    && !(value.cliDisabled && value.cliActive);
  if (!validInstance(rawInstance)) throw invalidState();
  return rawInstance;
}

function parseVersionThree(value: JsonObject) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'instances'])
    || value.version !== AUTH_VERSION || !isJsonObject(value.instances)) throw invalidState();
  const state = emptyState();
  for (const [rawHost, rawInstance] of Object.entries(value.instances)) {
    const host = normalizeInstance(rawHost);
    if (!validText(rawHost) || host !== rawHost || !isJsonObject(rawInstance)) throw invalidState();
    if (!isJsonArray(rawInstance.credentials)) {
      const reason = rawInstance.credentials == null
        ? `Cannot read properties of ${rawInstance.credentials} (reading 'map')`
        : 'rawInstance.credentials.map is not a function';
      throw new TypeError(reason);
    }
    const credentials = rawInstance.credentials.map((credential) => parseCredential(credential, host));
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
    const active = credentials.find((credential) => credential.credentialId === rawInstance.activeCredentialId);
    if (rawInstance.activeCredentialId !== null && !active) throw invalidState();
    state.instances[host] = {
      activeCredentialId: active?.credentialId ?? null,
      credentials,
      cliDisabled: rawInstance.cliDisabled,
      cliActive: rawInstance.cliActive,
      cliLogin: rawInstance.cliLogin ?? null,
    };
  }
  return state;
}

function parseVersionTwo(value: JsonObject): LocalState {
  const { version: _version, ...flatValue } = value;
  const flat = parseInstance({ ...flatValue, cliDisabled: false, cliActive: false });
  return { version: AUTH_VERSION, instances: {
    'github.com': {
      ...flat,
      credentials: flat.credentials.map((credential) => parseCredential(credential, 'github.com')),
    },
  } };
}

function parseLegacyUser(value: AuthJson | GitHubAccountInput['user'] | undefined) {
  const isLegacyRecord = (input: typeof value): input is JsonObject | GitHubAccountInput['user'] => isPlainObject(input);
  if (!isLegacyRecord(value) || !isInteger(value.id) || !validText(value.login)) throw invalidState();
  const user: AuthUser & { id: number } = { id: value.id, login: value.login };
  for (const key of avatarFields) {
    const field = value[key];
    if (field !== undefined && field !== null && !isString(field)) throw invalidState();
    if (isString(field)) user[key] = field;
  }
  return user;
}

function parseLegacyCredential(value: AuthJson): LocalCredential {
  if (!isJsonObject(value) || !validText(value.accessToken)) throw invalidState();
  const user = parseLegacyUser(value.user);
  const credentialId = githubAccountId(user.id);
  const status = value.status === 'invalid' ? 'invalid' : 'valid';
  const credential: LocalCredential = {
    credentialId,
    revision: 1,
    providerUserId: credentialId,
    accessToken: value.accessToken,
    scope: isString(value.scope) ? value.scope : '',
    tokenType: validText(value.tokenType) ? value.tokenType : 'bearer',
    createdAt: isSourceControlFiniteNumber(value.createdAt) && value.createdAt >= 0 ? value.createdAt : 0,
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

function migrateLegacy(value: AuthJson): LocalState {
  const raw = isJsonArray(value) ? value : [value];
  if (!raw.length) return emptyState();
  const selected = new Map<string, LocalCredential>();
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

const serializeCredential = (credential: LocalCredential) => {
  const stored: GitHubCredential = {
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

const fitsVersionTwo = (state: LocalState) => Object.keys(state.instances).every((host) => host === 'github.com')
  && !state.instances['github.com']?.cliDisabled && !state.instances['github.com']?.cliActive
  && !state.instances['github.com']?.cliLogin;

function serializeState(state: LocalState) {
  if (fitsVersionTwo(state)) {
    const instance = state.instances['github.com'];
    return {
      version: 2,
      activeCredentialId: instance?.activeCredentialId ?? null,
      credentials: (instance?.credentials ?? []).map(serializeCredential),
    };
  }
  const instances: Record<string, Omit<LocalInstance, 'credentials'> & { credentials: GitHubCredential[] }> = {};
  for (const [host, instance] of Object.entries(state.instances)) {
    instances[host] = {
      activeCredentialId: instance.activeCredentialId,
      credentials: instance.credentials.map((credential) => {
        const stored: GitHubCredential = {
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
    if (instance.cliLogin) instances[host].cliLogin = instance.cliLogin;
  }
  return { version: AUTH_VERSION, instances };
}

function publicCredential(credential: AuthCredentialFields, instance: { credentials: AuthCredentialFields[]; activeCredentialId: string | null }) {
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

export function createGitHubAuthStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }: StoreOptions = {}) {
  if (!validText(filePath)) throw new TypeError('GitHub auth file path is required');
  let transactions = Promise.resolve();
  const writeState = async (state: LocalState) => {
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
    let encoded: string;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return emptyState();
      throw error;
    }
    let value: AuthJson;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    if (isJsonObject(value) && Object.hasOwn(value, 'version')) {
      if (value.version === 2) return parseVersionTwo(value);
      return parseVersionThree(value);
    }
    const migrated = migrateLegacy(value);
    await writeState(migrated);
    return migrated;
  };
  const transaction = <Result>(operation: () => Promise<Result>) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    transactions = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = <Result>(operation: (state: LocalState) => Result) => transaction(async () => operation(await readState()));
  const mutate = <Result>(operation: (state: LocalState) => { changed: boolean | AuthJson | undefined; value: Result }) => transaction(async () => {
    const state = await readState();
    const result = operation(state);
    if (result.changed) await writeState(state);
    return result.value;
  });
  const instanceOf = (state: LocalState, host: Host) => state.instances[normalizeInstance(host)] ?? emptyInstance();
  const chooseActive = (instance: LocalInstance) => {
    const current = instance.credentials.find((credential) => credential.credentialId === instance.activeCredentialId);
    if (current?.status === 'valid') return;
    instance.activeCredentialId = instance.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? instance.credentials[0]?.credentialId
      ?? null;
  };
  const retainInstance = (instances: LocalState['instances'], host: string, instance: LocalInstance) => {
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive) delete instances[host];
    else instances[host] = instance;
  };
  const readAccountIn = (instance: LocalInstance, credentialId: string | undefined, revision?: number) => {
    const credential = instance.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (!credential || credential.status !== 'valid'
      || (revision !== undefined && credential.revision !== revision)) return null;
    return credential;
  };
  const hostMethods = {
    getActiveForHost: (host: Host) => read((state) => {
      const instance = instanceOf(state, host);
      const credential = instance.credentials.find((candidate) => candidate.credentialId === instance.activeCredentialId);
      return credential?.status === 'valid' ? credential : null;
    }),
    listAccountsForHost: (host: Host) => read((state) => instanceOf(state, host).credentials.map((credential) => publicCredential(credential, instanceOf(state, host)))),
    readAccountAnyInstance: (credentialId: string | undefined, revision?: number) => read((state) => {
      for (const [host, instance] of Object.entries(state.instances)) {
        const credential = readAccountIn(instance, credentialId, revision);
        if (credential) return { ...credential, host };
      }
      return null;
    }),
    setAccountForHost: (host: Host, { accessToken, scope, tokenType, user, source = 'oauth' }: SaveCredential) => mutate((state) => {
      if (!validText(accessToken) || !['oauth', 'pat'].includes(source)) throw new Error('Valid GitHub credential is required');
      const hostKey = normalizeInstance(host);
      const parsedUser = parseLegacyUser(user);
      const credentialId = newCredentialId();
      const instance = instanceOf(state, hostKey);
      const credential: LocalCredential = {
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
      instance.cliLogin = null;
      state.instances[hostKey] = instance;
      return { changed: true, value: credential };
    }),
    activateForHost: (host: Host, credentialId: string) => mutate((state) => {
      const instance = state.instances[normalizeInstance(host)];
      if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
        return { changed: false, value: false };
      }
      const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      instance.cliLogin = null;
      state.instances[normalizeInstance(host)] = instance;
      return { changed, value: true };
    }),
    markInvalidForHost: (host: GitHubErrorIdentity['instance'], credentialId: GitHubErrorIdentity['accountId'], reason = 'unauthorized') => mutate((state) => {
      const instance = state.instances[normalizeInstance(host)];
      const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!instance || !credential) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(instance);
      return { changed: true, value: true };
    }),
    removeAccountForHost: (host: Host, credentialId: string) => mutate((state) => {
      const instances = state.instances;
      const instance = instances[normalizeInstance(host)];
      const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
      if (!instance || index < 0) return { changed: false, value: false };
      instance.credentials.splice(index, 1);
      chooseActive(instance);
      retainInstance(instances, normalizeInstance(host), instance);
      return { changed: true, value: true };
    }),
    setCliDisabledForHost: (host: Host, disabled: boolean) => mutate((state) => {
      const hostKey = normalizeInstance(host);
      const instance = instanceOf(state, hostKey);
      const nextDisabled = Boolean(disabled);
      const nextActive = nextDisabled ? false : instance.cliActive;
      const nextLogin = nextDisabled ? null : instance.cliLogin ?? null;
      const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive
        || (instance.cliLogin ?? null) !== nextLogin;
      instance.cliDisabled = nextDisabled;
      instance.cliActive = nextActive;
      instance.cliLogin = nextLogin;
      retainInstance(state.instances, hostKey, instance);
      return { changed, value: instance.cliDisabled };
    }),
    setCliActiveForHost: (host: Host, active: boolean, login?: string | null) => mutate((state) => {
      const hostKey = normalizeInstance(host);
      const instance = instanceOf(state, hostKey);
      const nextActive = Boolean(active) && !instance.cliDisabled;
      const requested = validText(login) ? login : null;
      const nextLogin = !nextActive ? null : login === undefined ? (instance.cliLogin ?? null) : requested;
      const changed = instance.cliActive !== nextActive || (instance.cliLogin ?? null) !== nextLogin;
      instance.cliActive = nextActive;
      instance.cliLogin = nextLogin;
      retainInstance(state.instances, hostKey, instance);
      return { changed, value: instance.cliActive };
    }),
  };

  return Object.freeze({
    ...hostMethods,
    listAccounts: () => hostMethods.listAccountsForHost('github.com'),
    setAccount: (args: SaveCredential) => hostMethods.setAccountForHost('github.com', args),
    markInvalid: (credentialId: GitHubErrorIdentity['accountId'], reason?: string) => hostMethods.markInvalidForHost('github.com', credentialId, reason),
  });
}

const authStore = createGitHubAuthStore({ filePath: STORAGE_FILE });
const instanceAuthStore = () => createSourceControlAuthStore({ filePath: sourceControlAuthStoreFilePath() });

function readSettingsFile(): Settings {
  try {
    if (fsSync.existsSync(SETTINGS_FILE)) return JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
  return {};
}

function writeSettingsFile(settings: SettingsDocument) {
  fsSync.mkdirSync(STORAGE_DIR, { recursive: true });
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fsSync.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fsSync.renameSync(tmpFile, SETTINGS_FILE);
}

const githubInstanceAccounts = async (host: string) => {
  const instance = await instanceAuthStore().github.readInstance(host);
  return instance.accounts.map((credential) => publicCredential(credential, { activeCredentialId: instance.activeAccountId, credentials: instance.accounts }));
};
const getActiveForHost = async (host: string) => {
  const instance = await instanceAuthStore().github.readInstance(host);
  if (!instance.activeAccountId) return null;
  return instanceAuthStore().github.readAccount(host, instance.activeAccountId);
};
export const getGitHubAuthForHost = (host: string) => (normalizeInstance(host) === 'github.com'
  ? authStore.getActiveForHost(host)
  : getActiveForHost(host));
export const getGitHubAuth = (host?: string | null) => (normalizeInstance(host) === 'github.com'
  ? authStore.getActiveForHost(host)
  : getActiveForHost(host ?? ''));
export const getGitHubAuthAccounts = () => authStore.listAccountsForHost('github.com');
export const getGitHubAuthAccountsForHost = async (host: string) => (normalizeInstance(host) === 'github.com'
  ? authStore.listAccountsForHost(host)
  : githubInstanceAccounts(host));
export const getGitHubAuthByAccountId = async (credentialId: string | undefined, revision?: number) => {
  const instanceCredential = await instanceAuthStore().github.readAccountAnyInstance(credentialId, revision);
  if (instanceCredential) return instanceCredential;
  return authStore.readAccountAnyInstance(credentialId, revision);
};

export async function setGitHubAuth({ accessToken, scope, tokenType, user, accountId, source = 'oauth' }: SaveCredential & { accountId?: string }) {
  if (accountId !== undefined) throw new Error('GitHub credential IDs are server assigned');
  const credential = await authStore.setAccount({ accessToken, scope, tokenType, user, source });
  if (readSettingsFile().ghCliActive) setGhCliActive(false);
  return credential;
}

export async function setGitHubAuthForHost(host: string, { accessToken, scope, tokenType, user, source = 'oauth' }: SaveCredential) {
  const credential = normalizeInstance(host) === 'github.com'
    ? await authStore.setAccountForHost(host, { accessToken, scope, tokenType, user, source })
    : await instanceAuthStore().github.setAccount(host, { accessToken, scope, tokenType, user, source });
  if (normalizeInstance(host) === 'github.com' && readSettingsFile().ghCliActive) setGhCliActive(false);
  return credential;
}

export async function activateGitHubAuthForHost(host: string, credentialId: string) {
  const activated = normalizeInstance(host) === 'github.com'
    ? await authStore.activateForHost(host, credentialId)
    : await instanceAuthStore().github.activate(host, credentialId);
  if (activated && normalizeInstance(host) === 'github.com' && readSettingsFile().ghCliActive) setGhCliActive(false);
  return activated;
}
export interface GitHubErrorIdentity { instance?: unknown; accountId?: unknown }
export const markGitHubAuthAccountInvalid = (credentialId: GitHubErrorIdentity['accountId'], reason = 'unauthorized') => authStore.markInvalid(credentialId, reason);
export const markGitHubAuthAccountInvalidForHost = (host: GitHubErrorIdentity['instance'], credentialId: GitHubErrorIdentity['accountId'], reason = 'unauthorized') => {
  if (normalizeInstance(host) === 'github.com') return authStore.markInvalidForHost(host, credentialId, reason);
  const store: GitHubCredentialInvalidation<GitHubErrorIdentity['instance'], GitHubErrorIdentity['accountId']> = instanceAuthStore().github;
  return store.markAccountInvalid(host, credentialId, reason);
};
export const removeGitHubAuthAccountForHost = (host: string, credentialId: string) => (normalizeInstance(host) === 'github.com'
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

export function setGhCliDisabled(disabled: boolean) {
  const settings = readSettingsFileForUpdateSync(SETTINGS_FILE);
  settings.ghCliDisabled = Boolean(disabled);
  if (settings.ghCliDisabled) {
    settings.ghCliActive = false;
    settings.ghCliLogin = null;
  }
  writeSettingsFile(settings);
}

function isGhCliActive() {
  const settings = readSettingsFile();
  return !settings?.ghCliDisabled && Boolean(settings?.ghCliActive);
}

export function setGhCliActive(active: boolean, login?: string | null) {
  const settings = readSettingsFileForUpdateSync(SETTINGS_FILE);
  settings.ghCliActive = Boolean(active) && !settings.ghCliDisabled;
  const requested = isString(login) && login.trim() ? login.trim() : null;
  const existing = isString(settings.ghCliLogin) && settings.ghCliLogin.trim() ? settings.ghCliLogin.trim() : null;
  settings.ghCliLogin = !settings.ghCliActive ? null : login === undefined ? existing : requested;
  writeSettingsFile(settings);
}

export const isGhCliDisabledForHost = async (host: string) => {
  if (normalizeInstance(host) === 'github.com') return isGhCliDisabled();
  return (await instanceAuthStore().github.readInstance(host)).cliDisabled;
};

export const isGhCliActiveForHost = async (host: string) => {
  if (normalizeInstance(host) === 'github.com') return isGhCliActive();
  return (await instanceAuthStore().github.readInstance(host)).cliActive;
};

export const setGhCliDisabledForHost = (host: string, disabled: boolean) => (normalizeInstance(host) === 'github.com'
  ? setGhCliDisabled(disabled)
  : instanceAuthStore().github.setCliDisabled(host, disabled));

export const setGhCliActiveForHost = (host: string, active: boolean, login?: string | null) => (normalizeInstance(host) === 'github.com'
  ? setGhCliActive(active, login)
  : instanceAuthStore().github.setCliActive(host, active, login));

export const getGhCliLoginForHost = async (host: string) => {
  if (normalizeInstance(host) === 'github.com') {
    const settings = readSettingsFile();
    return !settings?.ghCliDisabled && settings?.ghCliActive && isString(settings?.ghCliLogin) && settings.ghCliLogin.trim()
      ? settings.ghCliLogin.trim()
      : null;
  }
  const instance = await instanceAuthStore().github.readInstance(host);
  return instance.cliActive && isString(instance.cliLogin) && instance.cliLogin.trim() ? instance.cliLogin.trim() : null;
};
