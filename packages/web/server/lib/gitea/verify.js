import { isPlainObject, isString } from '../shared/guards.js';
import { createGiteaClient, GiteaRequestError } from './client.js';

const MINIMUM_GITEA_VERSION = Object.freeze([1, 21]);

const FORGEJO_SUFFIX = /\+gitea-(\d+)\.(\d+)/;

const FORGEJO_NAMESPACE = 'forgejo';

export const isForgejoVersion = (value) => isString(value) && FORGEJO_SUFFIX.test(value);

function parseGiteaVersion(value) {
  if (!isString(value)) return null;
  const match = value.match(FORGEJO_SUFFIX) ?? value.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const atLeast = ([major, minor], [wantMajor, wantMinor]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

const isVersion = (payload) => isPlainObject(payload) && isString(payload.version);

const ANONYMOUS_VERSION_REFUSED = Symbol('anonymous version refused');

async function readVersion({ origin, token, fetch, timeoutMs, label, namespace = null }) {
  const client = (credential) => createGiteaClient({ origin, token: credential, fetch, timeoutMs, label, namespace });
  try {
    return await client(null).get('/version');
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    if (!token) return ANONYMOUS_VERSION_REFUSED;
    return client(token).get('/version');
  }
}

export async function probeGiteaVersion({ origin, token = null, fetch, timeoutMs, label = 'Gitea' }) {
  const options = { origin, token, fetch, timeoutMs, label };
  const payload = await readVersion(options);
  if (payload === ANONYMOUS_VERSION_REFUSED) return { version: null, supported: true, edition: null };
  if (!isVersion(payload)) {
    throw new GiteaRequestError('provider-error', `The instance did not answer as ${label}`);
  }
  let version = payload.version;
  let edition = isForgejoVersion(version) ? 'forgejo' : 'gitea';
  if (edition === 'gitea') {
    const own = await readVersion({ ...options, namespace: FORGEJO_NAMESPACE }).catch(() => null);
    if (isVersion(own)) {
      edition = 'forgejo';
      version = own.version;
    }
  }
  const parsed = parseGiteaVersion(version);
  return { version, supported: parsed === null || atLeast(parsed, MINIMUM_GITEA_VERSION), edition };
}

function parseGiteaUser(payload, label) {
  if (!isPlainObject(payload) || !Number.isInteger(payload.id) || payload.id < 0
    || !isString(payload.login) || !payload.login.trim()) {
    throw new GiteaRequestError('provider-error', `Invalid ${label} user response`);
  }
  const user = { id: payload.id, login: payload.login.trim() };
  if (isString(payload.avatar_url) && payload.avatar_url) user.avatarUrl = payload.avatar_url;
  if (isString(payload.full_name) && payload.full_name) user.name = payload.full_name;
  if (isString(payload.email) && payload.email) user.email = payload.email;
  return user;
}

export async function verifyGiteaToken({ origin, token, fetch, timeoutMs, label = 'Gitea' }) {
  const client = createGiteaClient({ origin, token, fetch, timeoutMs, label });
  return parseGiteaUser(await client.get('/user'), label);
}
