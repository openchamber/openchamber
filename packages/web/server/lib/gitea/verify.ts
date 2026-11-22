import { isPlainObject, isString } from '../shared/guards.js';
import { createGiteaClient, GiteaRequestError } from './client.js';
import type { GiteaClientOptions } from './client.js';

export type GiteaVerificationOptions = Pick<GiteaClientOptions, 'origin' | 'token' | 'fetch' | 'timeoutMs' | 'label'>;

interface VersionOptions extends GiteaVerificationOptions {
  namespace?: string | null;
}

interface VersionPayload {
  version: string;
}

interface UserPayload {
  id: number;
  login: string;
  avatar_url?: unknown;
  full_name?: unknown;
  email?: unknown;
}

export interface GiteaUser {
  id: number;
  login: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

interface VersionFailure {
  status?: unknown;
}

const isVersionFailure = (value: unknown): value is VersionFailure => value !== null && value !== undefined;
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const isGiteaUser = (payload: unknown): payload is UserPayload => isPlainObject(payload) && isNonNegativeInteger(payload.id)
  && isString(payload.login) && Boolean(payload.login.trim());

const MINIMUM_GITEA_VERSION: readonly [number, number] = Object.freeze([1, 21]);

const FORGEJO_SUFFIX = /\+gitea-(\d+)\.(\d+)/;

const FORGEJO_NAMESPACE = 'forgejo';

export const isForgejoVersion = (value: string | null | undefined) => isString(value) && FORGEJO_SUFFIX.test(value);

function parseGiteaVersion(value: string | null): [number, number] | null {
  if (!isString(value)) return null;
  const match = value.match(FORGEJO_SUFFIX) ?? value.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const atLeast = ([major, minor]: readonly [number, number], [wantMajor, wantMinor]: readonly [number, number]) => major > wantMajor || (major === wantMajor && minor >= wantMinor);

const isVersion = (payload: unknown): payload is VersionPayload => isPlainObject(payload) && isString(payload.version);

const ANONYMOUS_VERSION_REFUSED = Symbol('anonymous version refused');

async function readVersion({ origin, token, fetch, timeoutMs, label, namespace = null }: VersionOptions) {
  const client = (credential: string | null) => createGiteaClient({ origin, token: credential, fetch, timeoutMs, label, namespace });
  try {
    return await client(null).get('/version');
  } catch (error) {
    const failure = isVersionFailure(error) ? error : undefined;
    if (failure?.status !== 401 && failure?.status !== 403) throw error;
    if (!token) return ANONYMOUS_VERSION_REFUSED;
    return client(token).get('/version');
  }
}

export async function probeGiteaVersion({ origin, token = null, fetch, timeoutMs, label = 'Gitea' }: GiteaVerificationOptions) {
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

function parseGiteaUser(payload: UserPayload | null, label: string) {
  if (!payload) {
    throw new GiteaRequestError('provider-error', `Invalid ${label} user response`);
  }
  const user: GiteaUser = { id: payload.id, login: payload.login.trim() };
  if (isString(payload.avatar_url) && payload.avatar_url) user.avatarUrl = payload.avatar_url;
  if (isString(payload.full_name) && payload.full_name) user.name = payload.full_name;
  if (isString(payload.email) && payload.email) user.email = payload.email;
  return user;
}

export async function verifyGiteaToken({ origin, token, fetch, timeoutMs, label = 'Gitea' }: GiteaVerificationOptions) {
  const client = createGiteaClient({ origin, token, fetch, timeoutMs, label });
  const payload = await client.get('/user');
  return parseGiteaUser(isGiteaUser(payload) ? payload : null, label);
}
