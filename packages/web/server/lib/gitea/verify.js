import { isPlainObject, isString } from '../shared/guards.js';
import { createGiteaClient, GiteaRequestError } from './client.js';

/** The oldest Gitea release whose API this module is written against. */
const MINIMUM_GITEA_VERSION = Object.freeze([1, 21]);

// Forgejo names the Gitea release its API is compatible with after its own
// version (`17.0.0+gitea-1.22.0`); Gitea itself never does.
const FORGEJO_SUFFIX = /\+gitea-(\d+)\.(\d+)/;

// Forgejo's own API namespace, beside the Gitea-compatible `v1` it serves on
// the same origin. No Gitea release serves it.
const FORGEJO_NAMESPACE = 'forgejo';

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

const isVersion = (payload) => isPlainObject(payload) && isString(payload.version);

const ANONYMOUS_VERSION_REFUSED = Symbol('anonymous version refused');

/**
 * `/version` from one namespace, read anonymously first. An instance that
 * refuses anonymous reads (`REQUIRE_SIGNIN_VIEW`) is asked again with the
 * token when there is one; without one the refusal answers a sentinel, which
 * leaves the edition and the version unknown.
 */
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

/**
 * Whether an instance answers as Gitea or Forgejo, and whether its version is
 * one this module supports: Gitea 1.21, which Forgejo 7.0 is compatible with,
 * or newer.
 *
 * The edition is what names the card the instance can be connected on, and
 * the two editions are told apart by two signals. A `+gitea-` suffix on
 * `/version` is Forgejo's. Forgejo 16 stopped putting that suffix on its
 * Gitea-compatible `/version` and answers with its own version alone
 * (`16.0.6`), so a `/version` without the suffix is asked for a second time
 * in Forgejo's own namespace, which reports both (`16.0.6+gitea-1.22.0`).
 * Only Forgejo serves that namespace, so an answer there is the edition
 * itself, whatever the string says; Gitea answers it with a 404.
 *
 * An unparseable version is let through: a compatible server that words it
 * differently still works.
 */
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
    // A namespace that cannot be read at all is not an edition signal: the
    // instance stays Gitea, as a Gitea release answers it.
    const own = await readVersion({ ...options, namespace: FORGEJO_NAMESPACE }).catch(() => null);
    if (isVersion(own)) {
      edition = 'forgejo';
      version = own.version;
    }
  }
  const parsed = parseGiteaVersion(version);
  return { version, supported: parsed === null || atLeast(parsed, MINIMUM_GITEA_VERSION), edition };
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
