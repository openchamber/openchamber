import { isPlainObject, isString } from '../shared/guards.js';
import { createGiteaClient, GiteaRequestError } from './client.js';

/** The oldest Gitea release whose API this module is written against. */
const MINIMUM_GITEA_VERSION = Object.freeze([1, 21]);

// Forgejo names the Gitea release its API is compatible with after its own
// version (`17.0.0+gitea-1.22.0`); Gitea itself never does.
const FORGEJO_SUFFIX = /\+gitea-(\d+)\.(\d+)/;

/** Whether a `/version` string is Forgejo's. */
export const isForgejoVersion = (value) => isString(value) && FORGEJO_SUFFIX.test(value);

/**
 * The Gitea version a `/version` string names. Forgejo's compatible Gitea
 * version wins over its own. Null when the string names no version.
 */
function parseGiteaVersion(value) {
  if (!isString(value)) return null;
  const match = value.match(FORGEJO_SUFFIX) ?? value.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const atLeast = ([major, minor], [wantMajor, wantMinor]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

/**
 * Whether an instance answers as Gitea or Forgejo, and whether its version is
 * one this module supports: Gitea 1.21, which Forgejo 7.0 is compatible with,
 * or newer. `/version` is read anonymously first; an instance that refuses
 * anonymous reads (`REQUIRE_SIGNIN_VIEW`) is asked again with the token
 * when there is one. Without one a refusal leaves the instance unknown, so
 * it is let through and the sign-in decides. An unparseable version is let
 * through too: a compatible server that words it differently still works.
 */
export async function probeGiteaVersion({ origin, token = null, fetch, timeoutMs, label = 'Gitea' }) {
  let payload;
  try {
    payload = await createGiteaClient({ origin, token: null, fetch, timeoutMs, label }).get('/version');
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    if (!token) return { version: null, supported: true };
    payload = await createGiteaClient({ origin, token, fetch, timeoutMs, label }).get('/version');
  }
  if (!isPlainObject(payload) || !isString(payload.version)) {
    throw new GiteaRequestError('provider-error', `The instance did not answer as ${label}`);
  }
  const parsed = parseGiteaVersion(payload.version);
  return { version: payload.version, supported: parsed === null || atLeast(parsed, MINIMUM_GITEA_VERSION) };
}

/** A `/user` answer as the auth store keeps it. */
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

/** The token's user; a refused token is `invalid-token`, as every 401 is. */
export async function verifyGiteaToken({ origin, token, fetch, timeoutMs, label = 'Gitea' }) {
  const client = createGiteaClient({ origin, token, fetch, timeoutMs, label });
  return parseGiteaUser(await client.get('/user'), label);
}
