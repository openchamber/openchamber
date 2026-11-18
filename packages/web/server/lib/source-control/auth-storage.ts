import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSourceControlObject as isPlainObject, isSourceControlString as isString, hasSourceControlErrorCode, isSourceControlInteger, isSourceControlFiniteNumber } from './input-guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isExtensionProviderId, isProviderId } from './provider-id.js';
import { normalizeSshUrl } from './ssh-url.js';

export type AuthJson = null | boolean | number | string | AuthJson[] | { [key: string]: AuthJson };
export type AuthUser = {
  id: number | string;
  login: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
};
export type AuthUserInput = Omit<AuthUser, 'avatarUrl' | 'name' | 'email'> & {
  avatarUrl?: string | null | undefined;
  name?: string | null | undefined;
  email?: string | null | undefined;
};
export type AuthCredentialFields = {
  credentialId: string;
  revision: number;
  providerUserId: string;
  user: AuthUser;
  source: 'oauth' | 'pat';
  scope: string;
  status: 'valid' | 'invalid';
  invalidReason?: string | undefined;
};
export type OriginCredential = AuthCredentialFields & {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  accessToken?: never;
  tokenType?: never;
  createdAt?: never;
};
export type GitHubCredential = AuthCredentialFields & {
  accessToken: string;
  tokenType: string;
  createdAt: number;
  token?: never;
  refreshToken?: never;
  expiresAt?: never;
};
type StoredCredential = OriginCredential | GitHubCredential;
export type AuthCredential = StoredCredential & { id: string; credentialRevision: number; accountId?: string };
type SerializedGitHubCredential = Omit<GitHubCredential, 'accessToken' | 'tokenType' | 'createdAt'> & {
  [Key in 'accessToken' | 'tokenType' | 'createdAt']-?: AuthCredential[Key];
};
export type AuthInstance<Credential = AuthCredential> = {
  activeCredentialId: string | null;
  credentials: Credential[];
  cliDisabled: boolean;
  cliActive: boolean;
  cliLogin?: string | null;
  sshUrl?: string | null;
};
export type AuthSection = {
  instances: { [instance: string]: AuthInstance };
  raw?: never;
};
export interface PublicAuthInstance {
  activeAccountId: string | null;
  accounts: AuthCredential[];
  cliDisabled: boolean;
  cliActive: boolean;
  sshUrl?: string;
  cliLogin?: string;
}
type RawAuthSection = { raw: { [key: string]: AuthJson }; instances?: never };
interface AuthState {
  version: number;
  providers: { [provider: string]: AuthSection | RawAuthSection; gitlab: AuthSection; github: AuthSection };
}
interface InstanceParser {
  parseInstanceKey: (raw: string) => string;
  parseCredentialFor: (credential: AuthJson, instance: string) => AuthCredential;
  allowSshUrl?: boolean;
}
export interface OriginAccountInput {
  token: string;
  user: AuthUserInput;
  source: 'oauth' | 'pat';
  scope?: string;
  refreshToken?: string;
  expiresIn?: number;
}
export interface GitHubAccountInput {
  accessToken: string;
  user: AuthUserInput;
  source: 'oauth' | 'pat';
  scope?: string;
  tokenType?: string;
}
export interface AuthStoreOptions {
  filePath: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
  refreshOAuthToken?: (input: { provider: string; origin: string; refreshToken: string }) => Promise<{
    accessToken: string; refreshToken?: string; expiresIn?: number;
  }>;
  now?: () => number;
}

const AUTH_VERSION = 3;
const EXTRA_SECTIONS_VERSION = 4;
const INSTANCE_SSH_URL_VERSION = 5;
const BUILT_IN_SECTIONS = ['gitlab', 'github'];
const emptyState = (): AuthState => ({ version: AUTH_VERSION, providers: { gitlab: { instances: {} }, github: { instances: {} } } });
const emptyInstance = (): AuthInstance => ({ activeCredentialId: null, credentials: [], cliDisabled: false, cliActive: false });
const invalidState = (cause?: ErrorOptions['cause']) => Object.assign(new Error('Source control auth storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_AUTH',
});
const validText = (value: unknown): value is string => isString(value) && value.length > 0 && value.trim() === value && !/[\0\r\n]/.test(value);
const exactKeys = <Value extends object>(value: Value, required: string[], optional: string[] = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
function jsonObject(value: AuthJson | undefined): value is { [key: string]: AuthJson };
function jsonObject(value: AuthJson | AuthUserInput | undefined): value is { [key: string]: AuthJson } | AuthUserInput;
function jsonObject(value: AuthJson | AuthUserInput | undefined) {
  return isPlainObject(value);
}
const integer = (value: AuthJson | undefined): value is number => Number.isInteger(value);
const userId = (value: AuthJson | undefined, provider: string | undefined): value is number | string => isExtensionProviderId(provider)
  ? isSourceControlInteger(value) && value > 0 || isString(value) && value.length > 0 && value.length <= 256
  : integer(value);
type CredentialInput = Omit<OriginCredential, 'providerUserId' | 'user' | 'invalidReason' | 'refreshToken' | 'expiresAt'> & {
  providerUserId: AuthJson; user: AuthJson; invalidReason?: AuthJson; refreshToken?: AuthJson; expiresAt?: AuthJson;
};
const credentialInput = (value: AuthJson, provider: string): value is CredentialInput => jsonObject(value)
  && exactKeys(value, ['credentialId', 'revision', 'providerUserId', 'token', 'user', 'source', 'scope', 'status'],
    ['invalidReason', 'refreshToken', 'expiresAt'])
  && validText(value.credentialId) && isSourceControlInteger(value.revision) && value.revision >= 1
  && (isExtensionProviderId(provider) || validText(value.providerUserId)) && validText(value.token)
  && (value.source === 'oauth' || value.source === 'pat') && isString(value.scope)
  && (value.status === 'valid' || value.status === 'invalid');
const credentialOptions = (value: CredentialInput): value is CredentialInput & Pick<OriginCredential, 'invalidReason' | 'refreshToken' | 'expiresAt'> =>
  (value.invalidReason === undefined || validText(value.invalidReason))
  && (value.status !== 'valid' || value.invalidReason === undefined)
  && (value.refreshToken === undefined || value.source === 'oauth' && validText(value.refreshToken))
  && (value.expiresAt === undefined || isSourceControlInteger(value.expiresAt) && value.expiresAt >= 0);
type GitHubCredentialInput = Omit<GitHubCredential, 'user' | 'invalidReason'> & { user: AuthJson; invalidReason?: AuthJson };
const githubCredentialInput = (value: AuthJson): value is GitHubCredentialInput => jsonObject(value)
  && exactKeys(value, ['credentialId', 'revision', 'providerUserId', 'accessToken', 'scope', 'tokenType', 'createdAt', 'user', 'source', 'status'], ['invalidReason'])
  && validText(value.credentialId) && isSourceControlInteger(value.revision) && value.revision >= 1
  && validText(value.providerUserId) && validText(value.accessToken) && isString(value.scope) && validText(value.tokenType)
  && isSourceControlFiniteNumber(value.createdAt) && value.createdAt >= 0
  && (value.source === 'oauth' || value.source === 'pat') && (value.status === 'valid' || value.status === 'invalid');
const githubCredentialOptions = (value: GitHubCredentialInput): value is GitHubCredentialInput & Pick<GitHubCredential, 'invalidReason'> =>
  (value.invalidReason === undefined || validText(value.invalidReason)) && (value.status !== 'valid' || value.invalidReason === undefined);
type InstanceInput = {
  activeCredentialId: string | null; credentials: AuthJson[]; cliDisabled: boolean; cliActive: boolean;
  cliLogin?: string | null; sshUrl?: AuthJson;
};
const instanceInput = (value: AuthJson | undefined, allowSshUrl: boolean): value is InstanceInput => jsonObject(value)
  && exactKeys(value, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'], [...(allowSshUrl ? ['sshUrl'] : []), 'cliLogin'])
  && (value.activeCredentialId === null || validText(value.activeCredentialId)) && Array.isArray(value.credentials)
  && Object.prototype.toString.call(value.cliDisabled) === '[object Boolean]'
  && Object.prototype.toString.call(value.cliActive) === '[object Boolean]'
  && (value.cliLogin === undefined || value.cliLogin === null || validText(value.cliLogin))
  && !(value.cliDisabled && value.cliActive);

function providerUserId(origin: string, userId: AuthUser['id']) {
  return `${origin}#${userId}`;
}

function newCredentialId(provider: string) {
  return `occred:v1:${provider}:${randomUUID()}:r1`;
}

function parseUser(value: AuthJson | AuthUserInput | undefined, provider?: string) {
  const id = jsonObject(value) ? value.id : undefined;
  const validId = userId(id, provider);
  if (!jsonObject(value) || !validId || !validText(value.login)
    || !exactKeys(value, ['id', 'login'], ['avatarUrl', 'name', 'email'])) throw invalidState();
  const user: AuthUser = { id, login: value.login };
  for (const key of ['avatarUrl', 'name', 'email'] as const) {
    if (value[key] !== undefined && value[key] !== null && !isString(value[key])) throw invalidState();
    if (isString(value[key])) user[key] = value[key];
  }
  return user;
}

function runtimeCredential(value: OriginCredential) {
  return { ...value, id: value.credentialId, credentialRevision: value.revision };
}

function runtimeGitHubCredential(value: GitHubCredential) {
  return { ...value, id: value.credentialId, accountId: value.credentialId, credentialRevision: value.revision };
}

function parseCredential(value: AuthJson, origin: string, provider: string) {
  if (!credentialInput(value, provider)) throw invalidState();
  const user = parseUser(value.user, provider);
  if (providerUserId(origin, user.id) !== value.providerUserId) throw invalidState();
  if (!credentialOptions(value)) throw invalidState();
  return runtimeCredential({ ...value, providerUserId: value.providerUserId, user });
}

function parseGitHubCredential(value: AuthJson, host: string) {
  if (!githubCredentialInput(value)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserId(host, user.id) !== value.providerUserId) throw invalidState();
  if (!githubCredentialOptions(value)) throw invalidState();
  return runtimeGitHubCredential({ ...value, user });
}

function parseProviderInstances(rawInstances: AuthJson | undefined, { parseInstanceKey, parseCredentialFor, allowSshUrl = false }: InstanceParser) {
  if (!jsonObject(rawInstances)) throw invalidState();
  const instances: AuthSection['instances'] = {};
  for (const [rawKey, rawInstance] of Object.entries(rawInstances)) {
    const key = parseInstanceKey(rawKey);
    if (key !== rawKey || !instanceInput(rawInstance, allowSshUrl)) throw invalidState();
    let normalized: string | null | undefined;
    if (rawInstance.sshUrl !== undefined) {
      try { normalized = normalizeSshUrl(isString(rawInstance.sshUrl) ? rawInstance.sshUrl : null); }
      catch { throw invalidState(); }
      if (normalized !== rawInstance.sshUrl) throw invalidState();
    }
    const credentials = rawInstance.credentials.map((credential) => parseCredentialFor(credential, key));
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
    if (rawInstance.activeCredentialId !== null
      && !credentials.some((credential) => credential.credentialId === rawInstance.activeCredentialId)) throw invalidState();
    instances[key] = {
      activeCredentialId: rawInstance.activeCredentialId,
      credentials,
      cliDisabled: rawInstance.cliDisabled,
      cliActive: rawInstance.cliActive,
      cliLogin: rawInstance.cliLogin ?? null,
    };
    if (normalized !== undefined) instances[key].sshUrl = normalized;
  }
  return instances;
}

const originInstanceParser = (provider: string) => ({
  parseInstanceKey: (raw: string) => {
    let origin;
    try { origin = normalizeOriginInstance(raw, { label: provider }); }
    catch (error) { throw invalidState(error); }
    return origin;
  },
  parseCredentialFor: (credential: AuthJson, origin: string) => parseCredential(credential, origin, provider),
});
const gitlabInstanceParser = originInstanceParser('gitlab');
const githubInstanceParser = {
  parseInstanceKey: (raw: string) => {
    if (!validText(raw)) throw invalidState();
    return raw;
  },
  parseCredentialFor: parseGitHubCredential,
};

function parseGitLabSection(value: AuthJson | undefined) {
  if (!jsonObject(value) || !exactKeys(value, ['gitlab']) || !jsonObject(value.gitlab) || !exactKeys(value.gitlab, ['instances'])) throw invalidState();
  return { gitlab: { instances: parseProviderInstances(value.gitlab.instances, gitlabInstanceParser) } };
}

function parseSection(value: AuthJson | undefined, parser: InstanceParser, allowSshUrl = false): AuthSection {
  if (!jsonObject(value) || !exactKeys(value, ['instances'])) throw invalidState();
  return { instances: parseProviderInstances(value.instances, { ...parser, allowSshUrl }) };
}

function parseVersionThreeToFive(value: AuthJson): AuthState {
  if (!jsonObject(value) || !exactKeys(value, ['version', 'providers'])
    || !(value.version === AUTH_VERSION || value.version === EXTRA_SECTIONS_VERSION || value.version === INSTANCE_SSH_URL_VERSION)
    || !jsonObject(value.providers)) throw invalidState();
  const extraIds = Object.keys(value.providers).filter((id) => !BUILT_IN_SECTIONS.includes(id));
  const sections = value.providers;
  if (!BUILT_IN_SECTIONS.every((id) => Object.hasOwn(sections, id))
    || (value.version === AUTH_VERSION && extraIds.length)
    || extraIds.some((id) => !isProviderId(id) || !isPlainObject(sections[id]))) throw invalidState();
  const allowSshUrl = value.version === INSTANCE_SSH_URL_VERSION;
  const providers: AuthState['providers'] = {
    gitlab: parseSection(value.providers.gitlab, gitlabInstanceParser, allowSshUrl),
    github: parseSection(value.providers.github, githubInstanceParser, allowSshUrl),
  };
  for (const id of extraIds) {
    const raw = value.providers[id];
    if (!jsonObject(raw)) throw invalidState();
    providers[id] = { raw };
  }
  return { version: value.version, providers };
}

function serializeOriginSection(section: AuthSection) {
  const instances: { [origin: string]: AuthInstance<Omit<OriginCredential, 'token'> & { token: AuthCredential['token'] }> } = {};
  for (const [origin, instance] of Object.entries(section.instances)) {
    instances[origin] = {
      activeCredentialId: instance.activeCredentialId,
      credentials: instance.credentials.map((credential) => {
        const stored: Omit<OriginCredential, 'token'> & { token: AuthCredential['token'] } = {
          credentialId: credential.credentialId,
          revision: credential.revision,
          providerUserId: credential.providerUserId,
          token: credential.token,
          user: credential.user,
          source: credential.source,
          scope: credential.scope,
          status: credential.status,
        };
        if (credential.status === 'invalid') stored.invalidReason = credential.invalidReason;
        if (credential.refreshToken) stored.refreshToken = credential.refreshToken;
        if (credential.expiresAt !== undefined) stored.expiresAt = credential.expiresAt;
        return stored;
      }),
      cliDisabled: instance.cliDisabled,
      cliActive: instance.cliActive,
    };
    if (instance.sshUrl) instances[origin].sshUrl = instance.sshUrl;
  }
  return instances;
}

const isEmptyRawSection = (raw: RawAuthSection['raw']) => exactKeys(raw, ['instances'])
  && isPlainObject(raw.instances) && Object.keys(raw.instances).length === 0;

function serializeState(state: AuthState) {
  const instances = serializeOriginSection(state.providers.gitlab);
  const githubInstances: { [host: string]: AuthInstance<SerializedGitHubCredential> } = {};
  for (const [host, instance] of Object.entries(state.providers.github.instances)) {
    githubInstances[host] = {
      activeCredentialId: instance.activeCredentialId,
      credentials: instance.credentials.map((credential) => {
        const stored: SerializedGitHubCredential = {
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
    if (instance.cliLogin) githubInstances[host].cliLogin = instance.cliLogin;
    if (instance.sshUrl) githubInstances[host].sshUrl = instance.sshUrl;
  }
  const extras: { [provider: string]: RawAuthSection['raw'] | { instances: ReturnType<typeof serializeOriginSection> } } = {};
  for (const [id, section] of Object.entries(state.providers)) {
    if (BUILT_IN_SECTIONS.includes(id)) continue;
    if (section.raw !== undefined) {
      if (!isEmptyRawSection(section.raw)) extras[id] = section.raw;
      continue;
    }
    if (Object.keys(section.instances).length) extras[id] = { instances: serializeOriginSection(section) };
  }
  const providers = { gitlab: { instances }, github: { instances: githubInstances }, ...extras };
  const hasSshUrl = Object.values(providers).some((section) => isPlainObject(section.instances)
    && Object.values(section.instances).some((instance) => isPlainObject(instance) && 'sshUrl' in instance && instance.sshUrl !== undefined));
  if (hasSshUrl) return { version: INSTANCE_SSH_URL_VERSION, providers };
  if (Object.keys(extras).length) return { version: EXTRA_SECTIONS_VERSION, providers };
  if (Object.keys(githubInstances).length === 0) return { version: 2, providers: { gitlab: { instances } } };
  return { version: AUTH_VERSION, providers };
}

function publicInstance(instance: AuthInstance) {
  const result: PublicAuthInstance = {
    activeAccountId: instance.activeCredentialId,
    accounts: instance.credentials,
    cliDisabled: instance.cliDisabled,
    cliActive: instance.cliActive,
  };
  if (instance.sshUrl) result.sshUrl = instance.sshUrl;
  if (instance.cliLogin) result.cliLogin = instance.cliLogin;
  return result;
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const RENEW_LOCK_WAIT_MS = 15_000;

export function createSourceControlAuthStore({ filePath, fsImpl = fs, lockWaitMs = 2_000, refreshOAuthToken, now = Date.now }: AuthStoreOptions) {
  let transactions = Promise.resolve();
  const writeState = async (state: AuthState) => {
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
  const readState = async (): Promise<AuthState> => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return emptyState();
      throw error;
    }
    let value;
    try { value = JSON.parse(encoded); }
    catch (error) { throw invalidState(error); }
    if (value.version === 2) {
      return { version: AUTH_VERSION, providers: { ...parseGitLabSection(value.providers), github: { instances: {} } } };
    }
    return parseVersionThreeToFive(value);
  };
  const transaction = <Result>(operation: () => Promise<Result>) => {
    const next = transactions.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    transactions = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = <Result>(operation: (state: AuthState) => Result) => transaction(async () => operation(await readState()));
  const mutate = <Result>(operation: (state: AuthState) => { changed: boolean; value: Result }) => transaction(async () => {
    const state = await readState();
    const result = operation(state);
    if (result.changed) await writeState(state);
    return result.value;
  });
  const findInInstance = (instance: AuthInstance, credentialId: string, revision?: number) => {
    const credential = instance.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (!credential || credential.status !== 'valid'
      || (revision !== undefined && credential.revision !== revision)) return null;
    return credential;
  };
  const chooseActive = (instance: AuthInstance) => {
    const current = instance.credentials.find((credential) => credential.credentialId === instance.activeCredentialId);
    if (current?.status === 'valid') return;
    instance.activeCredentialId = instance.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? instance.credentials[0]?.credentialId
      ?? null;
  };
  const retainInstance = (instances: AuthSection['instances'], key: string, instance: AuthInstance) => {
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive && !instance.sshUrl) delete instances[key];
    else instances[key] = instance;
  };

  const needsRenewal = (credential: AuthCredential): credential is AuthCredential & { refreshToken: string } => credential.status === 'valid' && credential.source === 'oauth'
    && Boolean(credential.refreshToken) && credential.expiresAt !== undefined
    && credential.expiresAt - now() < REFRESH_MARGIN_MS;
  const renewals = new Map<string, Promise<boolean>>();
  const sectionInstances = (state: AuthState, provider: string) => {
    if (!Object.hasOwn(state.providers, provider)) return {};
    const section = state.providers[provider];
    if (!section) throw invalidState();
    if (section.raw !== undefined) {
      const parsed = parseSection(section.raw, originInstanceParser(provider), state.version === INSTANCE_SSH_URL_VERSION);
      state.providers[provider] = parsed;
      return parsed.instances;
    }
    return section.instances;
  };
  const writableInstances = (state: AuthState, provider: string) => {
    if (!Object.hasOwn(state.providers, provider)) state.providers[provider] = { instances: {} };
    return sectionInstances(state, provider);
  };
  const findCredential = (state: AuthState, provider: string, origin: string, credentialId: string) => sectionInstances(state, provider)[origin]?.credentials
    .find((candidate) => candidate.credentialId === credentialId) ?? null;
  const renew = (provider: string, origin: string, credential: AuthCredential, spent: string, refresh: NonNullable<AuthStoreOptions['refreshOAuthToken']>) => {
    const key = `${provider}\0${origin}\0${credential.credentialId}`;
    const pending = renewals.get(key);
    if (pending) return pending;
    const running = withSourceControlFileLock(`${filePath}.renew.lock`, async () => {
      const current = await read((state) => findCredential(state, provider, origin, credential.credentialId));
      if (current?.status !== 'valid') return false;
      if (current.refreshToken !== spent) return true;
      let renewed;
      try {
        renewed = await refresh({ provider, origin, refreshToken: spent });
      } catch {
        return false;
      }
      if (!validText(renewed?.accessToken)) return false;
      return mutate((state) => {
        const stored = findCredential(state, provider, origin, credential.credentialId);
        if (!stored || stored.refreshToken !== spent) return { changed: false, value: false };
        stored.token = renewed.accessToken;
        if (validText(renewed.refreshToken)) stored.refreshToken = renewed.refreshToken;
        if (isSourceControlFiniteNumber(renewed.expiresIn) && renewed.expiresIn > 0) stored.expiresAt = now() + renewed.expiresIn * 1000;
        else delete stored.expiresAt;
        return { changed: true, value: true };
      });
    }, { fsImpl, waitMs: RENEW_LOCK_WAIT_MS }).finally(() => { renewals.delete(key); });
    renewals.set(key, running);
    return running;
  };
  const renewExpiring = async (provider: string, origin: string, credentialId?: string) => {
    if (!(refreshOAuthToken instanceof Function)) return;
    const expiring = await read((state) => (sectionInstances(state, provider)[origin]?.credentials ?? [])
      .filter((credential): credential is AuthCredential & { refreshToken: string } => (!credentialId || credential.credentialId === credentialId) && needsRenewal(credential)));
    await Promise.all(expiring.map((credential) => renew(provider, origin, credential, credential.refreshToken, refreshOAuthToken).catch((error) => {
      if (!hasSourceControlErrorCode(error) || error.code !== 'SOURCE_CONTROL_LOCK_BUSY') throw error;
    })));
  };

  const originSection = (provider: string) => Object.freeze({
    listInstances: () => read((state) => Object.keys(sectionInstances(state, provider))),
    listSshUrls: () => read((state) => {
      const urls: { [origin: string]: string } = {};
      for (const [origin, instance] of Object.entries(sectionInstances(state, provider))) {
        if (instance.sshUrl) urls[origin] = instance.sshUrl;
      }
      return urls;
    }),
    listAccounts: (origin: string) => read((state) => sectionInstances(state, provider)[origin]?.credentials ?? []),
    renewAccount: async (origin: string, credentialId: string) => {
      if (!(refreshOAuthToken instanceof Function)) return false;
      const credential = await read((state) => sectionInstances(state, provider)[origin]?.credentials
        .find((candidate) => candidate.credentialId === credentialId) ?? null);
      if (credential?.status !== 'valid' || !credential.refreshToken) return false;
      return renew(provider, origin, credential, credential.refreshToken, refreshOAuthToken);
    },
    readInstance: async (origin: string) => {
      await renewExpiring(provider, origin);
      return read((state) => publicInstance(sectionInstances(state, provider)[origin] ?? emptyInstance()));
    },
    readAccount: async (origin: string, credentialId: string, revision?: number | null) => {
      await renewExpiring(provider, origin, credentialId);
      return read((state) => {
      const credential = sectionInstances(state, provider)[origin]?.credentials
        .find((candidate) => candidate.credentialId === credentialId);
      if (!credential || credential.status !== 'valid'
        || (revision !== undefined && credential.revision !== revision)) return null;
      return credential;
      });
    },
    setAccount: (origin: string, { token, user, source, scope = '', refreshToken, expiresIn }: OriginAccountInput) => mutate((state) => {
      if (!validText(token) || !['oauth', 'pat'].includes(source) || !isString(scope)) throw invalidState();
      const parsedUser = parseUser(user, provider);
      const credentialId = newCredentialId(provider);
      const credential: ReturnType<typeof runtimeCredential> = runtimeCredential({
        credentialId,
        revision: 1,
        providerUserId: providerUserId(origin, parsedUser.id),
        token,
        user: parsedUser,
        source,
        scope,
        status: 'valid',
      });
      if (source === 'oauth' && validText(refreshToken)) credential.refreshToken = refreshToken;
      if (source === 'oauth' && isSourceControlFiniteNumber(expiresIn) && expiresIn > 0) credential.expiresAt = now() + expiresIn * 1000;
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      instance.credentials.push(credential);
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      instances[origin] = instance;
      return { changed: true, value: credential };
    }),
    activate: (origin: string, credentialId: string) => mutate((state) => {
      const instance = sectionInstances(state, provider)[origin];
      if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
        return { changed: false, value: false };
      }
      const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      return { changed, value: true };
    }),
    removeAccount: (origin: string, credentialId: string) => mutate((state) => {
      const instances = writableInstances(state, provider);
      const instance = instances[origin];
      const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
      if (!instance || index < 0) return { changed: false, value: false };
      instance.credentials.splice(index, 1);
      chooseActive(instance);
      retainInstance(instances, origin, instance);
      return { changed: true, value: true };
    }),
    markAccountInvalid: (origin: string, credentialId: string, reason = 'unauthorized') => mutate((state) => {
      const instance = sectionInstances(state, provider)[origin];
      const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!instance || !credential) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(instance);
      return { changed: true, value: true };
    }),
    setSshUrl: (origin: string, sshUrl: string | null) => mutate((state) => {
      if (sshUrl !== null && !validText(sshUrl)) throw invalidState();
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      const next = sshUrl ?? undefined;
      const changed = instance.sshUrl !== next;
      if (next) instance.sshUrl = next;
      else delete instance.sshUrl;
      retainInstance(instances, origin, instance);
      return { changed, value: next ?? null };
    }),
    setCliDisabled: (origin: string, disabled: boolean) => mutate((state) => {
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      const nextDisabled = Boolean(disabled);
      const nextActive = nextDisabled ? false : instance.cliActive;
      const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive;
      instance.cliDisabled = nextDisabled;
      instance.cliActive = nextActive;
      retainInstance(instances, origin, instance);
      return { changed, value: instance.cliDisabled };
    }),
    setCliActive: (origin: string, active: boolean) => mutate((state) => {
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      const nextActive = Boolean(active) && !instance.cliDisabled;
      const changed = instance.cliActive !== nextActive;
      instance.cliActive = nextActive;
      retainInstance(instances, origin, instance);
      return { changed, value: instance.cliActive };
    }),
  });
  const sections = new Map<string, ReturnType<typeof originSection>>();
  const section = (provider: string) => {
    if (!isProviderId(provider) || provider === 'github') throw new Error(`Source control auth section is invalid: ${provider}`);
    const existing = sections.get(provider);
    if (existing) return existing;
    const created = originSection(provider);
    sections.set(provider, created);
    return created;
  };

  const dropSection = (provider: string) => {
    if (!isExtensionProviderId(provider)) return Promise.reject(new Error(`Source control auth section cannot be dropped: ${provider}`));
    return mutate((state) => {
      if (!Object.hasOwn(state.providers, provider)) return { changed: false, value: false };
      delete state.providers[provider];
      return { changed: true, value: true };
    });
  };

  return Object.freeze({
    ...section('gitlab'),
    section,
    dropSection,
    github: Object.freeze({
      listInstances: () => read((state) => Object.keys(state.providers.github.instances)),
      listAccounts: (host: string) => read((state) => state.providers.github.instances[host]?.credentials ?? []),
      readInstance: (host: string) => read((state) => publicInstance(state.providers.github.instances[host] ?? emptyInstance())),
      readAccount: (host: string, credentialId: string, revision?: number) => read((state) => findInInstance(state.providers.github.instances[host] ?? emptyInstance(), credentialId, revision)),
      readAccountAnyInstance: (credentialId: string, revision?: number) => read((state) => {
        for (const [host, instance] of Object.entries(state.providers.github.instances)) {
          const credential = findInInstance(instance, credentialId, revision);
          if (credential) return { ...credential, host };
        }
        return null;
      }),
      setAccount: (host: string, { accessToken, user, source, scope = '', tokenType = 'bearer' }: GitHubAccountInput) => mutate((state) => {
        if (!validText(accessToken) || !['oauth', 'pat'].includes(source) || !isString(scope) || !validText(tokenType)) throw invalidState();
        const parsedUser = parseUser(user);
        const credentialId = newCredentialId('github');
        const instances = state.providers.github.instances;
        const instance = instances[host] ?? emptyInstance();
        const credential = runtimeGitHubCredential({
          credentialId,
          revision: 1,
          providerUserId: providerUserId(host, parsedUser.id),
          accessToken,
          scope,
          tokenType,
          createdAt: Date.now(),
          user: parsedUser,
          source,
          status: 'valid',
        });
        instance.credentials.push(credential);
        instance.activeCredentialId = credentialId;
        instance.cliActive = false;
        instance.cliLogin = null;
        instances[host] = instance;
        return { changed: true, value: credential };
      }),
      activate: (host: string, credentialId: string) => mutate((state) => {
        const instance = state.providers.github.instances[host];
        if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
          return { changed: false, value: false };
        }
        const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
        instance.activeCredentialId = credentialId;
        instance.cliActive = false;
        instance.cliLogin = null;
        state.providers.github.instances[host] = instance;
        return { changed, value: true };
      }),
      markAccountInvalid: (host: string, credentialId: string, reason = 'unauthorized') => mutate((state) => {
        const instance = state.providers.github.instances[host];
        const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
        if (!instance || !credential) return { changed: false, value: false };
        if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
        credential.status = 'invalid';
        credential.invalidReason = validText(reason) ? reason : 'unauthorized';
        chooseActive(instance);
        return { changed: true, value: true };
      }),
      removeAccount: (host: string, credentialId: string) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host];
        const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
        if (!instance || index < 0) return { changed: false, value: false };
        const credential = instance.credentials[index];
        if (!credential) throw invalidState();
        const wasValid = credential.status === 'valid';
        instance.credentials.splice(index, 1);
        chooseActive(instance);
        retainInstance(instances, host, instance);
        return { changed: true, value: wasValid };
      }),
      setCliDisabled: (host: string, disabled: boolean) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host] ?? emptyInstance();
        const nextDisabled = Boolean(disabled);
        const nextActive = nextDisabled ? false : instance.cliActive;
        const nextLogin = nextDisabled ? null : instance.cliLogin ?? null;
        const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive
          || (instance.cliLogin ?? null) !== nextLogin;
        instance.cliDisabled = nextDisabled;
        instance.cliActive = nextActive;
        instance.cliLogin = nextLogin;
        retainInstance(instances, host, instance);
        return { changed, value: instance.cliDisabled };
      }),
      setCliActive: (host: string, active: boolean, login?: string) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host] ?? emptyInstance();
        const nextActive = Boolean(active) && !instance.cliDisabled;
        const requested = validText(login) ? login : null;
        const nextLogin = !nextActive ? null : login === undefined ? (instance.cliLogin ?? null) : requested;
        const changed = instance.cliActive !== nextActive || (instance.cliLogin ?? null) !== nextLogin;
        instance.cliActive = nextActive;
        instance.cliLogin = nextLogin;
        retainInstance(instances, host, instance);
        return { changed, value: instance.cliActive };
      }),
    }),
  });
}
