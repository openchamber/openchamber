import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeOriginInstance } from './origin-instance.js';
import { isExtensionProviderId, isProviderId } from './provider-id.js';
import { normalizeSshUrl } from './ssh-url.js';

const AUTH_VERSION = 3;
const EXTRA_SECTIONS_VERSION = 4;
const INSTANCE_SSH_URL_VERSION = 5;
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

function parseUser(value, provider) {
  const id = value?.id;
  const validId = isExtensionProviderId(provider)
    ? Number.isSafeInteger(id) && id > 0 || isString(id) && id.length > 0 && id.length <= 256
    : Number.isInteger(id);
  if (!isPlainObject(value) || !validId || !validText(value.login)
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

function parseCredential(value, origin, provider) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'token', 'user', 'source', 'scope', 'status',
    ], ['invalidReason', 'refreshToken', 'expiresAt'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (!isExtensionProviderId(provider) && !validText(value.providerUserId)) || !validText(value.token)
    || !['oauth', 'pat'].includes(value.source) || !isString(value.scope)
    || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user, provider);
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

function parseProviderInstances(rawInstances, { parseInstanceKey, parseCredentialFor, allowSshUrl = false }) {
  if (!isPlainObject(rawInstances)) throw invalidState();
  const instances = {};
  for (const [rawKey, rawInstance] of Object.entries(rawInstances)) {
    const key = parseInstanceKey(rawKey);
    if (key !== rawKey || !isPlainObject(rawInstance)
      || !exactKeys(rawInstance, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'], [...(allowSshUrl ? ['sshUrl'] : []), 'cliLogin'])
      || (rawInstance.activeCredentialId !== null && !validText(rawInstance.activeCredentialId))
      || !Array.isArray(rawInstance.credentials)
      || Object.prototype.toString.call(rawInstance.cliDisabled) !== '[object Boolean]'
      || Object.prototype.toString.call(rawInstance.cliActive) !== '[object Boolean]'
      || (rawInstance.cliLogin !== undefined && rawInstance.cliLogin !== null && !validText(rawInstance.cliLogin))
      || (rawInstance.cliDisabled && rawInstance.cliActive)) throw invalidState();
    if (rawInstance.sshUrl !== undefined) {
      let normalized;
      try { normalized = normalizeSshUrl(rawInstance.sshUrl); }
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
    if (rawInstance.sshUrl !== undefined) instances[key].sshUrl = rawInstance.sshUrl;
  }
  return instances;
}

const originInstanceParser = (provider) => ({
  parseInstanceKey: (raw) => {
    let origin;
    try { origin = normalizeOriginInstance(raw, { label: provider }); }
    catch (error) { throw invalidState(error); }
    return origin;
  },
  parseCredentialFor: (credential, origin) => parseCredential(credential, origin, provider),
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

function parseSection(value, parser, allowSshUrl = false) {
  if (!isPlainObject(value) || !exactKeys(value, ['instances'])) throw invalidState();
  return { instances: parseProviderInstances(value.instances, { ...parser, allowSshUrl }) };
}

function parseVersionThreeToFive(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'providers'])
    || ![AUTH_VERSION, EXTRA_SECTIONS_VERSION, INSTANCE_SSH_URL_VERSION].includes(value.version)
    || !isPlainObject(value.providers)) throw invalidState();
  const extraIds = Object.keys(value.providers).filter((id) => !BUILT_IN_SECTIONS.includes(id));
  if (!BUILT_IN_SECTIONS.every((id) => Object.hasOwn(value.providers, id))
    || (value.version === AUTH_VERSION && extraIds.length)
    || extraIds.some((id) => !isProviderId(id) || !isPlainObject(value.providers[id]))) throw invalidState();
  const allowSshUrl = value.version === INSTANCE_SSH_URL_VERSION;
  const providers = {
    gitlab: parseSection(value.providers.gitlab, gitlabInstanceParser, allowSshUrl),
    github: parseSection(value.providers.github, githubInstanceParser, allowSshUrl),
  };
  for (const id of extraIds) providers[id] = { raw: value.providers[id] };
  return { version: value.version, providers };
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
    if (instance.sshUrl) instances[origin].sshUrl = instance.sshUrl;
  }
  return instances;
}

const isEmptyRawSection = (raw) => exactKeys(raw, ['instances'])
  && isPlainObject(raw.instances) && Object.keys(raw.instances).length === 0;

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
    if (instance.cliLogin) githubInstances[host].cliLogin = instance.cliLogin;
    if (instance.sshUrl) githubInstances[host].sshUrl = instance.sshUrl;
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
  const providers = { gitlab: { instances }, github: { instances: githubInstances }, ...extras };
  const hasSshUrl = Object.values(providers).some((section) => isPlainObject(section.instances)
    && Object.values(section.instances).some((instance) => isPlainObject(instance) && instance.sshUrl !== undefined));
  if (hasSshUrl) return { version: INSTANCE_SSH_URL_VERSION, providers };
  if (Object.keys(extras).length) return { version: EXTRA_SECTIONS_VERSION, providers };
  if (Object.keys(githubInstances).length === 0) return { version: 2, providers: { gitlab: { instances } } };
  return { version: AUTH_VERSION, providers };
}

function publicInstance(instance) {
  const result = {
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
    if (value.version === 2) {
      return { version: AUTH_VERSION, providers: { ...parseGitLabSection(value.providers), github: { instances: {} } } };
    }
    return parseVersionThreeToFive(value);
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
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive && !instance.sshUrl) delete instances[key];
    else instances[key] = instance;
  };

  const needsRenewal = (credential) => credential.status === 'valid' && credential.source === 'oauth'
    && Boolean(credential.refreshToken) && credential.expiresAt !== undefined
    && credential.expiresAt - now() < REFRESH_MARGIN_MS;
  const renewals = new Map();
  const sectionInstances = (state, provider) => {
    if (!Object.hasOwn(state.providers, provider)) return {};
    const section = state.providers[provider];
    if (section.raw !== undefined) {
      state.providers[provider] = parseSection(section.raw, originInstanceParser(provider), state.version === INSTANCE_SSH_URL_VERSION);
    }
    return state.providers[provider].instances;
  };
  const writableInstances = (state, provider) => {
    if (!Object.hasOwn(state.providers, provider)) state.providers[provider] = { instances: {} };
    return sectionInstances(state, provider);
  };
  const findCredential = (state, provider, origin, credentialId) => sectionInstances(state, provider)[origin]?.credentials
    .find((candidate) => candidate.credentialId === credentialId) ?? null;
  // external: https://docs.gitlab.com/api/oauth2/ GitLab refresh tokens are single-use, so renewal is serialized across processes.
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
    await Promise.all(expiring.map((credential) => renew(provider, origin, credential).catch((error) => {
      if (error?.code !== 'SOURCE_CONTROL_LOCK_BUSY') throw error;
    })));
  };

  const originSection = (provider) => Object.freeze({
    listInstances: () => read((state) => Object.keys(sectionInstances(state, provider))),
    listSshUrls: () => read((state) => {
      const urls = {};
      for (const [origin, instance] of Object.entries(sectionInstances(state, provider))) {
        if (instance.sshUrl) urls[origin] = instance.sshUrl;
      }
      return urls;
    }),
    listAccounts: (origin) => read((state) => sectionInstances(state, provider)[origin]?.credentials ?? []),
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
      const parsedUser = parseUser(user, provider);
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
    setSshUrl: (origin, sshUrl) => mutate((state) => {
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

  const dropSection = (provider) => {
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
      listAccounts: (host) => read((state) => state.providers.github.instances[host]?.credentials ?? []),
      readInstance: (host) => read((state) => publicInstance(state.providers.github.instances[host] ?? emptyInstance())),
      readAccount: (host, credentialId, revision) => read((state) => findInInstance(state.providers.github.instances[host] ?? emptyInstance(), credentialId, revision)),
      readAccountAnyInstance: (credentialId, revision) => read((state) => {
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
        instance.cliLogin = null;
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
        instance.cliLogin = null;
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
        const nextLogin = nextDisabled ? null : instance.cliLogin ?? null;
        const changed = instance.cliDisabled !== nextDisabled || instance.cliActive !== nextActive
          || (instance.cliLogin ?? null) !== nextLogin;
        instance.cliDisabled = nextDisabled;
        instance.cliActive = nextActive;
        instance.cliLogin = nextLogin;
        retainInstance(instances, host, instance);
        return { changed, value: instance.cliDisabled };
      }),
      setCliActive: (host, active, login) => mutate((state) => {
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
