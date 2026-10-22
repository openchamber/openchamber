import { isPlainObject, isString } from '../shared/guards.js';
import { createGiteaClient, GiteaRequestError } from './client.js';

/** The oldest Gitea release whose API this module is written against. */
const MINIMUM_GITEA_VERSION = Object.freeze([1, 21]);

/**
 * The Gitea version a `/version` string names. Forgejo reports its own
 * version with the Gitea one it is compatible with (`7.0.5+gitea-1.21.11`);
 * that suffix wins. Null when the string names no version.
 */
function parseGiteaVersion(value) {
  if (!isString(value)) return null;
  const compatible = value.match(/\+gitea-(\d+)\.(\d+)/);
  const match = compatible ?? value.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const atLeast = ([major, minor], [wantMajor, wantMinor]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

/**
 * Whether an instance answers as Gitea, and whether its version is one this
 * module supports. `/version` needs no token. An unparseable version is let
 * through: a Gitea-compatible server that words it differently still works.
 */
export async function probeGiteaVersion({ origin, fetch, timeoutMs }) {
  const client = createGiteaClient({ origin, token: null, fetch, timeoutMs });
  const payload = await client.get('/version');
  if (!isPlainObject(payload) || !isString(payload.version)) {
    throw new GiteaRequestError('provider-error', 'The instance did not answer as Gitea');
  }
  const parsed = parseGiteaVersion(payload.version);
  return { version: payload.version, supported: parsed === null || atLeast(parsed, MINIMUM_GITEA_VERSION) };
}

/** A Gitea `/user` answer as the auth store keeps it. */
function parseGiteaUser(payload) {
  if (!isPlainObject(payload) || !Number.isInteger(payload.id) || payload.id < 0
    || !isString(payload.login) || !payload.login.trim()) {
    throw new GiteaRequestError('provider-error', 'Invalid Gitea user response');
  }
  const user = { id: payload.id, login: payload.login.trim() };
  if (isString(payload.avatar_url) && payload.avatar_url) user.avatarUrl = payload.avatar_url;
  if (isString(payload.full_name) && payload.full_name) user.name = payload.full_name;
  if (isString(payload.email) && payload.email) user.email = payload.email;
  return user;
}

/** The token's user; a refused token is `invalid-token`, as every Gitea 401 is. */
export async function verifyGiteaToken({ origin, token, fetch, timeoutMs }) {
  const client = createGiteaClient({ origin, token, fetch, timeoutMs });
  return parseGiteaUser(await client.get('/user'));
}
