import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isExtensionProviderId, isProviderId } from './provider-id.js';

const AUTH_VERSION = 3;
// Version 3 plus one origin-keyed section per further provider (Gitea and
// whatever follows). Written only while such a section holds something.
const EXTRA_SECTIONS_VERSION = 4;
// The two sections every version-3 file carries; any other provider id is an
// extra section.
const BUILT_IN_SECTIONS = ['gitlab', 'github'];
const emptyState = () => ({ version: AUTH_VERSION, providers: { gitlab: { instances: {} }, github: { instances: {} } } });
const emptyInstance = () => ({ activeCredentialId: null, credentials: [], cliDisabled: false, cliActive: false });
const invalidState = (cause) => Object.assign(new Error('Source control auth storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_AUTH',
});
const validText = (value) => isString(value) && value.length > 0 && value.trim() === value && !/[\0\r\n]/.test(value);
const exactKeys = (value, required, optional = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

function providerUserId(origin, userId) {
  return `${origin}#${userId}`;
}

function newCredentialId(provider) {
  return `occred:v1:${provider}:${randomUUID()}:r1`;
}

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

function runtimeCredential(value) {
  return { ...value, id: value.credentialId, credentialRevision: value.revision };
}

function runtimeGitHubCredential(value) {
  return { ...value, id: value.credentialId, accountId: value.credentialId, credentialRevision: value.revision };
}

function parseCredential(value, origin) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'token', 'user', 'source', 'scope', 'status',
    ], ['invalidReason', 'refreshToken', 'expiresAt'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validText(value.providerUserId) || !validText(value.token)
    || !['oauth', 'pat'].includes(value.source) || !isString(value.scope)
    || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserId(origin, user.id) !== value.providerUserId) throw invalidState();
  if (value.invalidReason !== undefined && !validText(value.invalidReason)) throw invalidState();
  if (value.status === 'valid' && value.invalidReason !== undefined) throw invalidState();
  if (value.refreshToken !== undefined && (value.source !== 'oauth' || !validText(value.refreshToken))) throw invalidState();
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) throw invalidState();
  return runtimeCredential({ ...value, user });
}

function parseGitHubCredential(value, host) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'accessToken', 'scope', 'tokenType', 'createdAt', 'user', 'source', 'status',
    ], ['invalidReason'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validText(value.providerUserId) || !validText(value.accessToken)
    || !isString(value.scope) || !validText(value.tokenType)
    || !Number.isFinite(value.createdAt) || value.createdAt < 0
    || !['oauth', 'pat'].includes(value.source) || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserId(host, user.id) !== value.providerUserId) throw invalidState();
  if (value.invalidReason !== undefined && !validText(value.invalidReason)) throw invalidState();
  if (value.status === 'valid' && value.invalidReason !== undefined) throw invalidState();
  return runtimeGitHubCredential({ ...value, user });
}

function parseProviderInstances(rawInstances, { parseInstanceKey, parseCredentialFor }) {
  if (!isPlainObject(rawInstances)) throw invalidState();
  const instances = {};
  for (const [rawKey, rawInstance] of Object.entries(rawInstances)) {
    const key = parseInstanceKey(rawKey);
    if (key !== rawKey || !isPlainObject(rawInstance)
      || !exactKeys(rawInstance, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'])
      || (rawInstance.activeCredentialId !== null && !validText(rawInstance.activeCredentialId))
      || !Array.isArray(rawInstance.credentials)
      || Object.prototype.toString.call(rawInstance.cliDisabled) !== '[object Boolean]'
      || Object.prototype.toString.call(rawInstance.cliActive) !== '[object Boolean]'
      || (rawInstance.cliDisabled && rawInstance.cliActive)) throw invalidState();
    const credentials = rawInstance.credentials.map((credential) => parseCredentialFor(credential, key));
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
    if (rawInstance.activeCredentialId !== null
      && !credentials.some((credential) => credential.credentialId === rawInstance.activeCredentialId)) throw invalidState();
    instances[key] = {
      activeCredentialId: rawInstance.activeCredentialId,
      credentials,
      cliDisabled: rawInstance.cliDisabled,
      cliActive: rawInstance.cliActive,
    };
  }
  return instances;
}

// Every section except GitHub's is keyed by instance origin, with the
// credential shape GitLab introduced.
const originInstanceParser = (provider) => ({
  parseInstanceKey: (raw) => {
    let origin;
    try { origin = normalizeOriginInstance(raw, { label: provider }); }
    catch (error) { throw invalidState(error); }
    return origin;
  },
  parseCredentialFor: parseCredential,
});
const gitlabInstanceParser = originInstanceParser('gitlab');
const githubInstanceParser = {
  parseInstanceKey: (raw) => {
    if (!validText(raw)) throw invalidState();
    return raw;
  },
  parseCredentialFor: parseGitHubCredential,
};

function parseGitLabSection(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['gitlab']) || !isPlainObject(value.gitlab) || !exactKeys(value.gitlab, ['instances'])) throw invalidState();
  return { gitlab: { instances: parseProviderInstances(value.gitlab.instances, gitlabInstanceParser) } };
}

function parseVersionTwo(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'providers']) || value.version !== 2 || !isPlainObject(value.providers)) throw invalidState();
  return { version: 2, providers: parseGitLabSection(value.providers) };
}

// Version 2 held only GitLab (`providers.gitlab.instances`, keyed by origin).
// Version 3 adds `providers.github.instances` (keyed by host) to this same
// server token store, so a GitHub Enterprise instance's personal access tokens
// live in the file GitLab already uses. A version 2 file is read into the
// version 3 shape in memory but stays version 2 on disk until a GitHub
// Enterprise credential is stored: earlier releases read only version 2, so
// a user who never added an enterprise host can still go back to one.
function parseSection(value, parser) {
  if (!isPlainObject(value) || !exactKeys(value, ['instances'])) throw invalidState();
  return { instances: parseProviderInstances(value.instances, parser) };
}

// Version 4 is version 3 plus extra sections keyed by provider id. An id is
// checked for syntax only, and an extra section is kept as read (`raw`) until
// a provider of this build asks for it, which parses it strictly then. A
// section no provider asks for is written back untouched, whatever its shape,
// so an older or newer provider set never loses another's credentials, and a
// section that does not parse fails only its own provider's calls.
function parseVersionThreeOrFour(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'providers'])
    || ![AUTH_VERSION, EXTRA_SECTIONS_VERSION].includes(value.version) || !isPlainObject(value.providers)) throw invalidState();
  const extraIds = Object.keys(value.providers).filter((id) => !BUILT_IN_SECTIONS.includes(id));
  if (!BUILT_IN_SECTIONS.every((id) => Object.hasOwn(value.providers, id))
    || (value.version === AUTH_VERSION && extraIds.length)
    || extraIds.some((id) => !isProviderId(id) || !isPlainObject(value.providers[id]))) throw invalidState();
  const providers = {
    gitlab: parseSection(value.providers.gitlab, gitlabInstanceParser),
    github: parseSection(value.providers.github, githubInstanceParser),
  };
  for (const id of extraIds) providers[id] = { raw: value.providers[id] };
  return { version: AUTH_VERSION, providers };
}

function serializeOriginSection(section) {
  const instances = {};
  for (const [origin, instance] of Object.entries(section.instances)) {
    instances[origin] = {
      activeCredentialId: instance.activeCredentialId,
      credentials: instance.credentials.map((credential) => {
        const stored = {
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
  }
  return instances;
}

const isEmptyRawSection = (raw) => exactKeys(raw, ['instances'])
  && isPlainObject(raw.instances) && Object.keys(raw.instances).length === 0;

/**
 * The oldest version that can hold the state, so a user who never needed a
 * newer one can still go back to a release that reads only the older:
 * version 2 while only GitLab holds anything, version 3 once a GitHub
 * Enterprise host is stored, version 4 only while an extra section is not
 * empty.
 */
function serializeState(state) {
  const instances = serializeOriginSection(state.providers.gitlab);
  const githubInstances = {};
  for (const [host, instance] of Object.entries(state.providers.github.instances)) {
    githubInstances[host] = {
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
  const extras = {};
  for (const [id, section] of Object.entries(state.providers)) {
    if (BUILT_IN_SECTIONS.includes(id)) continue;
    if (section.raw !== undefined) {
      if (!isEmptyRawSection(section.raw)) extras[id] = section.raw;
      continue;
    }
    if (Object.keys(section.instances).length) extras[id] = { instances: serializeOriginSection(section) };
  }
  if (Object.keys(extras).length) {
    return {
      version: EXTRA_SECTIONS_VERSION,
      providers: { gitlab: { instances }, github: { instances: githubInstances }, ...extras },
    };
  }
  if (Object.keys(githubInstances).length === 0) return { version: 2, providers: { gitlab: { instances } } };
  return { version: AUTH_VERSION, providers: { gitlab: { instances }, github: { instances: githubInstances } } };
}

function publicInstance(instance) {
  return {
    activeAccountId: instance.activeCredentialId,
    accounts: instance.credentials,
    cliDisabled: instance.cliDisabled,
    cliActive: instance.cliActive,
  };
}

// A token this close to expiring is renewed before it is handed out, so a
// request never starts with one that dies on the way.
const REFRESH_MARGIN_MS = 5 * 60_000;
// Longer than one refresh request may take, so a process waiting on another's
// renewal sees its result.
const RENEW_LOCK_WAIT_MS = 15_000;

/**
 * `refreshOAuthToken({ provider, origin, refreshToken })` trades an OAuth
 * refresh token for `{ accessToken, refreshToken?, expiresIn? }`. Without it,
 * stored OAuth tokens are handed out as they are.
 */
export function createSourceControlAuthStore({ filePath, fsImpl = fs, lockWaitMs = 2_000, refreshOAuthToken, now = Date.now }) {
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
    // Version 2 was GitLab-only; it is read into the version 3 shape after
    // validation (`github` starts empty) without rewriting the file.
    if (value.version === 2) {
      return { version: AUTH_VERSION, providers: { ...parseGitLabSection(value.providers), github: { instances: {} } } };
    }
    return parseVersionThreeOrFour(value);
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
  const findInInstance = (instance, credentialId, revision) => {
    const credential = instance.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (!credential || credential.status !== 'valid'
      || (revision !== undefined && credential.revision !== revision)) return null;
    return credential;
  };
  const chooseActive = (instance) => {
    const current = instance.credentials.find((credential) => credential.credentialId === instance.activeCredentialId);
    if (current?.status === 'valid') return;
    instance.activeCredentialId = instance.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? instance.credentials[0]?.credentialId
      ?? null;
  };
  const retainInstance = (instances, key, instance) => {
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive) delete instances[key];
    else instances[key] = instance;
  };

  const needsRenewal = (credential) => credential.status === 'valid' && credential.source === 'oauth'
    && Boolean(credential.refreshToken) && credential.expiresAt !== undefined
    && credential.expiresAt - now() < REFRESH_MARGIN_MS;
  const renewals = new Map();
  // An origin section that was never written reads as empty. An extra section
  // still as read parses strictly here, for the provider that asks for it.
  const sectionInstances = (state, provider) => {
    if (!Object.hasOwn(state.providers, provider)) return {};
    const section = state.providers[provider];
    if (section.raw !== undefined) state.providers[provider] = parseSection(section.raw, originInstanceParser(provider));
    return state.providers[provider].instances;
  };
  const writableInstances = (state, provider) => {
    if (!Object.hasOwn(state.providers, provider)) state.providers[provider] = { instances: {} };
    return sectionInstances(state, provider);
  };
  const findCredential = (state, provider, origin, credentialId) => sectionInstances(state, provider)[origin]?.credentials
    .find((candidate) => candidate.credentialId === credentialId) ?? null;
  /**
   * Renews one OAuth credential, once per credential however many readers
   * ask. GitLab revokes the access token and refresh token a refresh spends,
   * so two processes sharing this file (the desktop app and a web server)
   * must never spend the same refresh token: the loser's refresh is refused
   * and the token the winner stored stops working. Renewal therefore holds a
   * cross-process lock of its own for the network call, and a process that
   * waited on it finds the refresh token already replaced and uses the new
   * one. The credential keeps its id and revision, so bindings pinned to it
   * keep working. A rejected refresh leaves the credential as it is; the
   * request that then fails marks it invalid the usual way.
   */
  const renew = (provider, origin, credential) => {
    const key = `${provider}\0${origin}\0${credential.credentialId}`;
    const pending = renewals.get(key);
    if (pending) return pending;
    const spent = credential.refreshToken;
    const running = withSourceControlFileLock(`${filePath}.renew.lock`, async () => {
      const current = await read((state) => findCredential(state, provider, origin, credential.credentialId));
      if (current?.status !== 'valid') return false;
      if (current.refreshToken !== spent) return true;
      let renewed;
      try {
        renewed = await refreshOAuthToken({ provider, origin, refreshToken: spent });
      } catch {
        return false;
      }
      if (!validText(renewed?.accessToken)) return false;
      return mutate((state) => {
        const stored = findCredential(state, provider, origin, credential.credentialId);
        if (!stored || stored.refreshToken !== spent) return { changed: false, value: false };
        stored.token = renewed.accessToken;
        if (validText(renewed.refreshToken)) stored.refreshToken = renewed.refreshToken;
        if (Number.isFinite(renewed.expiresIn) && renewed.expiresIn > 0) stored.expiresAt = now() + renewed.expiresIn * 1000;
        else delete stored.expiresAt;
        return { changed: true, value: true };
      });
    }, { fsImpl, waitMs: RENEW_LOCK_WAIT_MS }).finally(() => { renewals.delete(key); });
    renewals.set(key, running);
    return running;
  };
  const renewExpiring = async (provider, origin, credentialId) => {
    if (!(refreshOAuthToken instanceof Function)) return;
    const expiring = await read((state) => (sectionInstances(state, provider)[origin]?.credentials ?? [])
      .filter((credential) => (!credentialId || credential.credentialId === credentialId) && needsRenewal(credential)));
    // A renewal still busy elsewhere leaves this read with the token as stored;
    // a request it then fails renews on demand.
    await Promise.all(expiring.map((credential) => renew(provider, origin, credential).catch((error) => {
      if (error?.code !== 'SOURCE_CONTROL_LOCK_BUSY') throw error;
    })));
  };

  /**
   * One origin-keyed section: GitLab's, and the one every further provider
   * gets under its own id. Credentials are the GitLab shape (`token`, optional
   * OAuth refresh), keyed by normalized origin; the caller normalizes.
   */
  const originSection = (provider) => Object.freeze({
    listInstances: () => read((state) => Object.keys(sectionInstances(state, provider))),
    listAccounts: (origin) => read((state) => sectionInstances(state, provider)[origin]?.credentials ?? []),
    /**
     * Renews an OAuth credential now, whatever its expiry says. For a request
     * GitLab just refused: true means a fresh token is stored and the account
     * should not be written off yet.
     */
    renewAccount: async (origin, credentialId) => {
      if (!(refreshOAuthToken instanceof Function)) return false;
      const credential = await read((state) => sectionInstances(state, provider)[origin]?.credentials
        .find((candidate) => candidate.credentialId === credentialId) ?? null);
      if (credential?.status !== 'valid' || !credential.refreshToken) return false;
      return renew(provider, origin, credential);
    },
    readInstance: async (origin) => {
      await renewExpiring(provider, origin);
      return read((state) => publicInstance(sectionInstances(state, provider)[origin] ?? emptyInstance()));
    },
    readAccount: async (origin, credentialId, revision) => {
      await renewExpiring(provider, origin, credentialId);
      return read((state) => {
      const credential = sectionInstances(state, provider)[origin]?.credentials
        .find((candidate) => candidate.credentialId === credentialId);
      if (!credential || credential.status !== 'valid'
        || (revision !== undefined && credential.revision !== revision)) return null;
      return credential;
      });
    },
    setAccount: (origin, { token, user, source, scope = '', refreshToken, expiresIn }) => mutate((state) => {
      if (!validText(token) || !['oauth', 'pat'].includes(source) || !isString(scope)) throw invalidState();
      const parsedUser = parseUser(user);
      const credentialId = newCredentialId(provider);
      const credential = runtimeCredential({
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
      if (source === 'oauth' && Number.isFinite(expiresIn) && expiresIn > 0) credential.expiresAt = now() + expiresIn * 1000;
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      instance.credentials.push(credential);
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      instances[origin] = instance;
      return { changed: true, value: credential };
    }),
    activate: (origin, credentialId) => mutate((state) => {
      const instance = sectionInstances(state, provider)[origin];
      if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
        return { changed: false, value: false };
      }
      const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      return { changed, value: true };
    }),
    removeAccount: (origin, credentialId) => mutate((state) => {
      const instances = writableInstances(state, provider);
      const instance = instances[origin];
      const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
      if (index < 0) return { changed: false, value: false };
      instance.credentials.splice(index, 1);
      chooseActive(instance);
      retainInstance(instances, origin, instance);
      return { changed: true, value: true };
    }),
    markAccountInvalid: (origin, credentialId, reason = 'unauthorized') => mutate((state) => {
      const instance = sectionInstances(state, provider)[origin];
      const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(instance);
      return { changed: true, value: true };
    }),
    setCliDisabled: (origin, disabled) => mutate((state) => {
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
    setCliActive: (origin, active) => mutate((state) => {
      const instances = writableInstances(state, provider);
      const instance = instances[origin] ?? emptyInstance();
      const nextActive = Boolean(active) && !instance.cliDisabled;
      const changed = instance.cliActive !== nextActive;
      instance.cliActive = nextActive;
      retainInstance(instances, origin, instance);
      return { changed, value: instance.cliActive };
    }),
  });
  const sections = new Map();
  const section = (provider) => {
    if (!isProviderId(provider) || provider === 'github') throw new Error(`Source control auth section is invalid: ${provider}`);
    if (!sections.has(provider)) sections.set(provider, originSection(provider));
    return sections.get(provider);
  };

  /**
   * Forgets an extension provider's whole section, every instance and
   * credential, in one locked write: removing an extension removes its
   * accounts. A built-in provider's section is never dropped this way. True
   * when the file held the section.
   */
  const dropSection = (provider) => {
    if (!isExtensionProviderId(provider)) return Promise.reject(new Error(`Source control auth section cannot be dropped: ${provider}`));
    return mutate((state) => {
      if (!Object.hasOwn(state.providers, provider)) return { changed: false, value: false };
      delete state.providers[provider];
      return { changed: true, value: true };
    });
  };

  return Object.freeze({
    // GitLab's section is the store's own surface, as it was before sections.
    ...section('gitlab'),
    section,
    dropSection,
    // GitHub Enterprise lives in this same server token store, next to GitLab:
    // one entry per host, each with its own credentials, active account and gh
    // CLI switch. github.com's device-flow accounts stay in github-auth.json;
    // the github module routes every non-github.com host here (`github/auth.js`).
    github: Object.freeze({
      listInstances: () => read((state) => Object.keys(state.providers.github.instances)),
      listAccounts: (host) => read((state) => state.providers.github.instances[host]?.credentials ?? []),
      readInstance: (host) => read((state) => publicInstance(state.providers.github.instances[host] ?? emptyInstance())),
      readAccount: (host, credentialId, revision) => read((state) => findInInstance(state.providers.github.instances[host] ?? emptyInstance(), credentialId, revision)),
      readAccountAnyInstance: (credentialId, revision) => read((state) => {
        // The instance a credential id belongs to travels with the record, so a
        // caller knows which API root its token belongs to.
        for (const [host, instance] of Object.entries(state.providers.github.instances)) {
          const credential = findInInstance(instance, credentialId, revision);
          if (credential) return { ...credential, host };
        }
        return null;
      }),
      setAccount: (host, { accessToken, user, source, scope = '', tokenType = 'bearer' }) => mutate((state) => {
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
        instances[host] = instance;
        return { changed: true, value: credential };
      }),
      activate: (host, credentialId) => mutate((state) => {
        const instance = state.providers.github.instances[host];
        if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
          return { changed: false, value: false };
        }
        const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
        instance.activeCredentialId = credentialId;
        instance.cliActive = false;
        state.providers.github.instances[host] = instance;
        return { changed, value: true };
      }),
      markAccountInvalid: (host, credentialId, reason = 'unauthorized') => mutate((state) => {
        const instance = state.providers.github.instances[host];
        const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
        if (!credential) return { changed: false, value: false };
        if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
        credential.status = 'invalid';
        credential.invalidReason = validText(reason) ? reason : 'unauthorized';
        chooseActive(instance);
        return { changed: true, value: true };
      }),
      removeAccount: (host, credentialId) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host];
        const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
        if (index < 0) return { changed: false, value: false };
        const wasValid = instance.credentials[index].status === 'valid';
        instance.credentials.splice(index, 1);
        chooseActive(instance);
        retainInstance(instances, host, instance);
        return { changed: true, value: wasValid };
      }),
      setCliDisabled: (host, disabled) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host] ?? emptyInstance();
        const nextDisabled = Boolean(disabled);
        const nextActive = nextDisabled ? false : instance.cliActive;
        const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive;
        instance.cliDisabled = nextDisabled;
        instance.cliActive = nextActive;
        retainInstance(instances, host, instance);
        return { changed, value: instance.cliDisabled };
      }),
      setCliActive: (host, active) => mutate((state) => {
        const instances = state.providers.github.instances;
        const instance = instances[host] ?? emptyInstance();
        const nextActive = Boolean(active) && !instance.cliDisabled;
        const changed = instance.cliActive !== nextActive;
        instance.cliActive = nextActive;
        retainInstance(instances, host, instance);
        return { changed, value: instance.cliActive };
      }),
    }),
  });
}
