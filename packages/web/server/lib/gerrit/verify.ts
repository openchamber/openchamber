import { isPlainObject, isString } from '../shared/guards.js';
import { createGerritClient, GerritRequestError } from './client.js';
import type { GerritClientOptions } from './client.js';
import type { GerritJson } from './contracts.js';
import type { TransportCredential } from '../source-control/provider-contract.js';

const MINIMUM_GERRIT_VERSION: readonly [number, number] = Object.freeze([3, 8]);
const stringValue = (value: unknown): value is string => isString(value);
const plainObject = (value: GerritJson): value is { [key: string]: GerritJson } => isPlainObject(value);
const isInteger = (value: GerritJson | undefined): value is number => Number.isInteger(value);
const errorRecord = (value: unknown): value is Record<string, unknown> => value !== null
  && (typeof value === 'object' || typeof value === 'function');

const parseGerritVersion = (value: string): [number, number] | null => {
  const match = value.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const atLeast = ([major, minor]: readonly [number, number], [wantMajor, wantMinor]: readonly [number, number]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

const responseError = (status: number, body: { error: string; code: string }) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

export async function probeGerritVersion({ origin, login, password, fetch, timeoutMs }: GerritClientOptions) {
  let payload;
  try {
    payload = await createGerritClient({ origin, fetch, timeoutMs }).get('/config/server/version');
  } catch (error) {
    const status = errorRecord(error) ? error.status : undefined;
    if (status !== 401 && status !== 403) throw error;
    if (!login || !password) return { version: null, supported: true };
    payload = await createGerritClient({ origin, login, password, fetch, timeoutMs }).get('/config/server/version');
  }
  if (!stringValue(payload) || !payload.trim()) throw new GerritRequestError('provider-error', 'The instance did not answer as Gerrit');
  const parsed = parseGerritVersion(payload);
  return { version: payload, supported: parsed === null || atLeast(parsed, MINIMUM_GERRIT_VERSION) };
}

function parseGerritAccount(payload: GerritJson) {
  if (!plainObject(payload) || !isInteger(payload._account_id) || payload._account_id < 0) {
    throw new GerritRequestError('provider-error', 'Invalid Gerrit account response');
  }
  if (!stringValue(payload.username) || !payload.username.trim()) {
    throw responseError(400, { error: 'This Gerrit account has no username for Git over HTTP', code: 'GERRIT_ACCOUNT_WITHOUT_USERNAME' });
  }
  const user: TransportCredential['user'] & { login: string } = { id: payload._account_id, login: payload.username.trim() };
  if (stringValue(payload.name) && payload.name) user.name = payload.name;
  if (stringValue(payload.email) && payload.email) user.email = payload.email;
  const avatar = Array.isArray(payload.avatars) ? payload.avatars.find((entry): entry is { [key: string]: GerritJson } & { url: string } => entry !== null && plainObject(entry) && stringValue(entry.url) && Boolean(entry.url)) : null;
  if (avatar) user.avatarUrl = avatar.url;
  return user;
}

export async function verifyGerritCredentials({ origin, login, password, fetch, timeoutMs }: GerritClientOptions) {
  if (!stringValue(login) || !login.trim()) {
    throw responseError(400, { error: 'A Gerrit username is required', code: 'GERRIT_USERNAME_REQUIRED' });
  }
  if (!stringValue(password) || !password) {
    throw responseError(400, { error: 'A Gerrit HTTP password is required', code: 'GERRIT_PASSWORD_REQUIRED' });
  }
  const client = createGerritClient({ origin, login: login.trim(), password, fetch, timeoutMs });
  return parseGerritAccount(await client.get('/accounts/self'));
}
