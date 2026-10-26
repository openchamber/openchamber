import { isPlainObject, isString } from '../shared/guards.js';
import { createGerritClient, GerritRequestError } from './client.js';

/** The oldest Gerrit release this module supports (3.8.9 and 3.10.9 verified live, see DOCUMENTATION.md). */
const MINIMUM_GERRIT_VERSION = Object.freeze([3, 8]);

const parseGerritVersion = (value) => {
  const match = isString(value) ? value.match(/^v?(\d+)\.(\d+)/) : null;
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const atLeast = ([major, minor], [wantMajor, wantMinor]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

/** An error the shell answers with exactly this status and body. */
const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

/**
 * Whether an instance answers as Gerrit, and whether its version is one this
 * module supports. `/config/server/version` is read anonymously first; an
 * instance that refuses anonymous reads is asked again with the credentials
 * when there are any. Without them a refusal leaves the instance unknown,
 * so it is let through and the sign-in decides. An unparseable version is
 * let through too.
 */
export async function probeGerritVersion({ origin, login, password, fetch, timeoutMs }) {
  let payload;
  try {
    payload = await createGerritClient({ origin, fetch, timeoutMs }).get('/config/server/version');
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    if (!login || !password) return { version: null, supported: true };
    payload = await createGerritClient({ origin, login, password, fetch, timeoutMs }).get('/config/server/version');
  }
  if (!isString(payload) || !payload.trim()) throw new GerritRequestError('provider-error', 'The instance did not answer as Gerrit');
  const parsed = parseGerritVersion(payload);
  return { version: payload, supported: parsed === null || atLeast(parsed, MINIMUM_GERRIT_VERSION) };
}

/** A Gerrit `AccountInfo` as the auth store keeps it; `login` is the Gerrit username. */
function parseGerritAccount(payload) {
  if (!isPlainObject(payload) || !Number.isInteger(payload._account_id) || payload._account_id < 0) {
    throw new GerritRequestError('provider-error', 'Invalid Gerrit account response');
  }
  if (!isString(payload.username) || !payload.username.trim()) {
    throw responseError(400, { error: 'This Gerrit account has no username for Git over HTTP', code: 'GERRIT_ACCOUNT_WITHOUT_USERNAME' });
  }
  const user = { id: payload._account_id, login: payload.username.trim() };
  if (isString(payload.name) && payload.name) user.name = payload.name;
  if (isString(payload.email) && payload.email) user.email = payload.email;
  const avatar = Array.isArray(payload.avatars) ? payload.avatars.find((entry) => isString(entry?.url) && entry.url) : null;
  if (avatar) user.avatarUrl = avatar.url;
  return user;
}

/**
 * The account a username and HTTP password sign in as. Gerrit's Basic auth
 * needs the username before the first request, so a password alone cannot
 * be verified; a refused pair is `invalid-token`, as every Gerrit 401 is.
 */
export async function verifyGerritCredentials({ origin, login, password, fetch, timeoutMs }) {
  if (!isString(login) || !login.trim()) {
    throw responseError(400, { error: 'A Gerrit username is required', code: 'GERRIT_USERNAME_REQUIRED' });
  }
  if (!isString(password) || !password) {
    throw responseError(400, { error: 'A Gerrit HTTP password is required', code: 'GERRIT_PASSWORD_REQUIRED' });
  }
  const client = createGerritClient({ origin, login: login.trim(), password, fetch, timeoutMs });
  return parseGerritAccount(await client.get('/accounts/self'));
}
