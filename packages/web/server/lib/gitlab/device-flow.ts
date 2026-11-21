import { fetchWithTimeout, GitLabRequestError } from './network.js';
import { isString } from './validation.js';

export interface GitLabOAuthPayload {
  version?: unknown;
  error?: unknown;
  error_description?: unknown;
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
}

export interface GitLabDeviceAuthorization extends GitLabOAuthPayload {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitLabOAuthOptions {
  origin: string;
  clientId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface GitLabAuthCapability {
  available: boolean;
  reason?: string;
}

export interface GitLabOAuthRenewal {
  refreshToken?: string;
  expiresIn?: number;
}

type GitLabDeviceExchange =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'error'; error: unknown; message: unknown }
  | ({ status: 'connected'; accessToken: string; scope: string } & GitLabOAuthRenewal);

interface FetchFailure { message?: unknown }
const hasFailureMessage = (value: unknown): value is FetchFailure => value != null;
const hasOAuthFields = (value: unknown): value is GitLabOAuthPayload => value != null;
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isDeviceAuthorization = (payload: GitLabOAuthPayload | null | undefined): payload is GitLabDeviceAuthorization =>
  isString(payload?.device_code) && isString(payload.user_code) && isString(payload.verification_uri)
  && isFiniteNumber(payload.expires_in) && isFiniteNumber(payload.interval);

async function readJson(response: Response) {
  try {
    const payload: unknown = await response.json();
    return hasOAuthFields(payload) ? payload : payload === undefined ? undefined : null;
  } catch {
    return null;
  }
}

function form(fields: Record<string, string>) {
  return new URLSearchParams(Object.entries(fields).filter(([, value]) => isString(value) && value));
}

const HOSTED_GITLAB_ORIGIN = 'https://gitlab.com';
const HOSTED_GITLAB_CLIENT_ID = 'b5db9852a2368e2fd232a9945d94123fb61cf4af67e7eca680418929f93bcf59';

export const defaultGitLabClientId = (origin: string) => (origin === HOSTED_GITLAB_ORIGIN ? HOSTED_GITLAB_CLIENT_ID : '');

export async function resolveGitLabClientId(origin: string, readSettings?: (() => Promise<{ gitlabClientId?: unknown } | null>) | undefined) {
  const envValue = isString(process.env.OPENCHAMBER_GITLAB_CLIENT_ID) ? process.env.OPENCHAMBER_GITLAB_CLIENT_ID.trim() : '';
  if (envValue) return envValue;
  const settings = await readSettings?.();
  const stored = isString(settings?.gitlabClientId) ? settings.gitlabClientId.trim() : '';
  return stored || defaultGitLabClientId(origin);
}

function requestDeviceAuthorization(origin: string, clientId: string, fetchImpl: typeof fetch, timeoutMs: number) {
  return fetchWithTimeout(fetchImpl, `${origin}/oauth/authorize_device`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, scope: 'api' }),
  }, timeoutMs);
}

const cliCapability = (available: boolean) => {
  const capability: GitLabAuthCapability = { available };
  if (!available) capability.reason = 'cli-unavailable';
  return capability;
};

export async function probeGitLabAuth({ origin, clientId, fetch: fetchImpl = fetch, timeoutMs = 10_000, glabAvailable = false }: GitLabOAuthOptions & { glabAvailable?: boolean }) {
  let versionResponse;
  try {
    versionResponse = await fetchWithTimeout(fetchImpl, `${origin}/api/v4/version`, { headers: { Accept: 'application/json' } }, timeoutMs);
  } catch (error) {
    throw new GitLabRequestError('unreachable', (hasFailureMessage(error) ? error.message : undefined) || 'GitLab instance is unreachable');
  }
  if (versionResponse.status === 429 || versionResponse.status >= 500) {
    throw new GitLabRequestError('temporarily-unavailable', 'GitLab instance is temporarily unavailable', versionResponse.status);
  }
  const versionPayload = await readJson(versionResponse);
  const requiresAuthentication = versionResponse.status === 401 || versionResponse.status === 403;
  const hasGitLabMarker = isString(versionResponse.headers.get('x-gitlab-meta'));
  const confirmed = (versionResponse.ok && versionPayload && isString(versionPayload.version))
    || (requiresAuthentication && hasGitLabMarker);
  if (!confirmed) return { confirmed: false, device: { available: false, reason: 'not-gitlab' }, pat: { available: false, reason: 'not-gitlab' }, cli: { available: false, reason: 'not-gitlab' } };

  if (!clientId) {
    return {
      confirmed: true,
      device: { available: false, reason: 'invalid-client' },
      pat: { available: true },
      cli: cliCapability(glabAvailable),
    };
  }

  let response;
  try {
    response = await requestDeviceAuthorization(origin, clientId, fetchImpl, timeoutMs);
  } catch (error) {
    throw new GitLabRequestError('unreachable', (hasFailureMessage(error) ? error.message : undefined) || 'GitLab instance is unreachable');
  }
  const payload = await readJson(response);
  if (response.ok) return { confirmed: true, device: { available: true }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (response.status === 404 || response.status === 405) return { confirmed: true, device: { available: false, reason: 'unsupported' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (payload?.error === 'invalid_client') return { confirmed: true, device: { available: false, reason: 'invalid-client' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (response.status === 429 || response.status >= 500) throw new GitLabRequestError('temporarily-unavailable', 'GitLab authentication is temporarily unavailable', response.status);
  return { confirmed: true, device: { available: false, reason: 'provider-error' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
}

export async function startGitLabDeviceFlow({ origin, clientId, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: GitLabOAuthOptions) {
  const response = await requestDeviceAuthorization(origin, clientId, fetchImpl, timeoutMs);
  const payload = await readJson(response);
  if (!response.ok) {
    const kind = response.status === 429 || response.status >= 500 ? 'temporarily-unavailable' : 'provider-error';
    throw new GitLabRequestError(kind, payload?.error_description || payload?.error || 'Failed to start GitLab device flow', response.status);
  }
  if (!isDeviceAuthorization(payload)) throw new GitLabRequestError('provider-error', 'Invalid GitLab device flow response');
  return payload;
}

export async function exchangeGitLabDeviceCode({ origin, clientId, deviceCode, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: GitLabOAuthOptions & { deviceCode: string }): Promise<GitLabDeviceExchange> {
  const response = await fetchWithTimeout(fetchImpl, `${origin}/oauth/token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  }, timeoutMs);
  const payload = await readJson(response);
  if (payload?.error === 'authorization_pending' || payload?.error === 'slow_down') return { status: payload.error };
  if (!response.ok) return { status: 'error', error: payload?.error || 'provider_error', message: payload?.error_description || 'GitLab authentication failed' };
  if (!isString(payload?.access_token) || !payload.access_token) throw new GitLabRequestError('provider-error', 'Missing access_token from GitLab');
  return { status: 'connected', accessToken: payload.access_token, scope: isString(payload.scope) ? payload.scope : '', ...renewal(payload) };
}

function renewal(payload: GitLabOAuthPayload) {
  const result: GitLabOAuthRenewal = {};
  if (isString(payload?.refresh_token) && payload.refresh_token) result.refreshToken = payload.refresh_token;
  if (isFiniteNumber(payload?.expires_in) && payload.expires_in > 0) result.expiresIn = payload.expires_in;
  return result;
}

export async function refreshGitLabAccessToken({ origin, clientId, refreshToken, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: GitLabOAuthOptions & { refreshToken: string }) {
  const response = await fetchWithTimeout(fetchImpl, `${origin}/oauth/token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  }, timeoutMs);
  const payload = await readJson(response);
  if (!response.ok) {
    const rejected = response.status === 400 || response.status === 401;
    throw new GitLabRequestError(rejected ? 'invalid-token' : 'temporarily-unavailable',
      payload?.error_description || payload?.error || 'GitLab token refresh failed', response.status);
  }
  if (!isString(payload?.access_token) || !payload.access_token) throw new GitLabRequestError('provider-error', 'Missing access_token from GitLab');
  return { accessToken: payload.access_token, ...renewal(payload) };
}
