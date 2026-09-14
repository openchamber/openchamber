import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeGitLabInstance } from './instance.js';
import { isPlainObject, isString } from './validation.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const AUTH_VERSION = 2;
const emptyState = () => ({ version: AUTH_VERSION, providers: { gitlab: { instances: {} } } });
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

function newCredentialId() {
  return `occred:v1:gitlab:${randomUUID()}:r1`;
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

function parseCredential(value, origin) {
  if (!isPlainObject(value)
    || !exactKeys(value, [
      'credentialId', 'revision', 'providerUserId', 'token', 'user', 'source', 'scope', 'status',
    ], ['invalidReason'])
    || !validText(value.credentialId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validText(value.providerUserId) || !validText(value.token)
    || !['oauth', 'pat'].includes(value.source) || !isString(value.scope)
    || !['valid', 'invalid'].includes(value.status)) throw invalidState();
  const user = parseUser(value.user);
  if (providerUserId(origin, user.id) !== value.providerUserId) throw invalidState();
  if (value.invalidReason !== undefined && !validText(value.invalidReason)) throw invalidState();
  if (value.status === 'valid' && value.invalidReason !== undefined) throw invalidState();
  return runtimeCredential({ ...value, user });
}

function parseVersionTwo(value) {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'providers']) || value.version !== AUTH_VERSION
    || !isPlainObject(value.providers) || !exactKeys(value.providers, ['gitlab'])
    || !isPlainObject(value.providers.gitlab) || !exactKeys(value.providers.gitlab, ['instances'])
    || !isPlainObject(value.providers.gitlab.instances)) throw invalidState();
  const state = emptyState();
  for (const [rawOrigin, rawInstance] of Object.entries(value.providers.gitlab.instances)) {
    let origin;
    try { origin = normalizeGitLabInstance(rawOrigin); }
    catch (error) { throw invalidState(error); }
    if (origin !== rawOrigin || !isPlainObject(rawInstance)
      || !exactKeys(rawInstance, ['activeCredentialId', 'credentials', 'cliDisabled', 'cliActive'])
      || (rawInstance.activeCredentialId !== null && !validText(rawInstance.activeCredentialId))
      || !Array.isArray(rawInstance.credentials)
      || Object.prototype.toString.call(rawInstance.cliDisabled) !== '[object Boolean]'
      || Object.prototype.toString.call(rawInstance.cliActive) !== '[object Boolean]'
      || (rawInstance.cliDisabled && rawInstance.cliActive)) throw invalidState();
    const credentials = rawInstance.credentials.map((credential) => parseCredential(credential, origin));
    if (new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length) throw invalidState();
    if (rawInstance.activeCredentialId !== null
      && !credentials.some((credential) => credential.credentialId === rawInstance.activeCredentialId)) throw invalidState();
    state.providers.gitlab.instances[origin] = {
      activeCredentialId: rawInstance.activeCredentialId,
      credentials,
      cliDisabled: rawInstance.cliDisabled,
      cliActive: rawInstance.cliActive,
    };
  }
  return state;
}

function serializeState(state) {
  const instances = {};
  for (const [origin, instance] of Object.entries(state.providers.gitlab.instances)) {
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
        return stored;
      }),
      cliDisabled: instance.cliDisabled,
      cliActive: instance.cliActive,
    };
  }
  return { version: AUTH_VERSION, providers: { gitlab: { instances } } };
}

function publicInstance(instance) {
  return {
    activeAccountId: instance.activeCredentialId,
    accounts: instance.credentials,
    cliDisabled: instance.cliDisabled,
    cliActive: instance.cliActive,
  };
}

export function createSourceControlAuthStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }) {
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
    if (value?.version !== AUTH_VERSION) throw invalidState();
    return parseVersionTwo(value);
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
  const chooseActive = (instance) => {
    const current = instance.credentials.find((credential) => credential.credentialId === instance.activeCredentialId);
    if (current?.status === 'valid') return;
    instance.activeCredentialId = instance.credentials.find((credential) => credential.status === 'valid')?.credentialId
      ?? instance.credentials[0]?.credentialId
      ?? null;
  };
  const retainInstance = (instances, origin, instance) => {
    if (!instance.credentials.length && !instance.cliDisabled && !instance.cliActive) delete instances[origin];
    else instances[origin] = instance;
  };

  return Object.freeze({
    listInstances: () => read((state) => Object.keys(state.providers.gitlab.instances)),
    listAccounts: (origin) => read((state) => state.providers.gitlab.instances[origin]?.credentials ?? []),
    readInstance: (origin) => read((state) => publicInstance(state.providers.gitlab.instances[origin] ?? emptyInstance())),
    readAccount: (origin, credentialId, revision) => read((state) => {
      const credential = state.providers.gitlab.instances[origin]?.credentials
        .find((candidate) => candidate.credentialId === credentialId);
      if (!credential || credential.status !== 'valid'
        || (revision !== undefined && credential.revision !== revision)) return null;
      return credential;
    }),
    setAccount: (origin, { token, user, source, scope = '' }) => mutate((state) => {
      if (!validText(token) || !['oauth', 'pat'].includes(source) || !isString(scope)) throw invalidState();
      const parsedUser = parseUser(user);
      const credentialId = newCredentialId();
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
      const instances = state.providers.gitlab.instances;
      const instance = instances[origin] ?? emptyInstance();
      instance.credentials.push(credential);
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      instances[origin] = instance;
      return { changed: true, value: credential };
    }),
    activate: (origin, credentialId) => mutate((state) => {
      const instance = state.providers.gitlab.instances[origin];
      if (!instance?.credentials.some((credential) => credential.credentialId === credentialId && credential.status === 'valid')) {
        return { changed: false, value: false };
      }
      const changed = instance.activeCredentialId !== credentialId || instance.cliActive;
      instance.activeCredentialId = credentialId;
      instance.cliActive = false;
      return { changed, value: true };
    }),
    removeAccount: (origin, credentialId) => mutate((state) => {
      const instances = state.providers.gitlab.instances;
      const instance = instances[origin];
      const index = instance?.credentials.findIndex((credential) => credential.credentialId === credentialId) ?? -1;
      if (index < 0) return { changed: false, value: false };
      instance.credentials.splice(index, 1);
      chooseActive(instance);
      retainInstance(instances, origin, instance);
      return { changed: true, value: true };
    }),
    markAccountInvalid: (origin, credentialId, reason = 'unauthorized') => mutate((state) => {
      const instance = state.providers.gitlab.instances[origin];
      const credential = instance?.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential) return { changed: false, value: false };
      if (credential.status === 'invalid' && credential.invalidReason === reason) return { changed: false, value: false };
      credential.status = 'invalid';
      credential.invalidReason = validText(reason) ? reason : 'unauthorized';
      chooseActive(instance);
      return { changed: true, value: true };
    }),
    setCliDisabled: (origin, disabled) => mutate((state) => {
      const instances = state.providers.gitlab.instances;
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
      const instances = state.providers.gitlab.instances;
      const instance = instances[origin] ?? emptyInstance();
      const nextActive = Boolean(active) && !instance.cliDisabled;
      const changed = instance.cliActive !== nextActive;
      instance.cliActive = nextActive;
      retainInstance(instances, origin, instance);
      return { changed, value: instance.cliActive };
    }),
  });
}
