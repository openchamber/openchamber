import { fetchWithTimeout, GitLabRequestError } from './network.js';
import { isString } from './validation.js';

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function form(fields) {
  return new URLSearchParams(Object.entries(fields).filter(([, value]) => isString(value) && value));
}

// OpenChamber registers its own OAuth application on gitlab.com only. A
// self-managed instance has no such application, so its operator supplies an
// id through OPENCHAMBER_GITLAB_CLIENT_ID or the `gitlabClientId` setting;
// until then that instance offers personal access tokens and `glab` instead.
const HOSTED_GITLAB_ORIGIN = 'https://gitlab.com';
const HOSTED_GITLAB_CLIENT_ID = 'b5db9852a2368e2fd232a9945d94123fb61cf4af67e7eca680418929f93bcf59';

export const defaultGitLabClientId = (origin) => (origin === HOSTED_GITLAB_ORIGIN ? HOSTED_GITLAB_CLIENT_ID : '');

/** The OAuth application an instance signs in with: env, then settings, then ours on gitlab.com. */
export async function resolveGitLabClientId(origin, readSettings) {
  const envValue = isString(process.env.OPENCHAMBER_GITLAB_CLIENT_ID) ? process.env.OPENCHAMBER_GITLAB_CLIENT_ID.trim() : '';
  if (envValue) return envValue;
  const settings = await readSettings?.();
  const stored = isString(settings?.gitlabClientId) ? settings.gitlabClientId.trim() : '';
  return stored || defaultGitLabClientId(origin);
}

function requestDeviceAuthorization(origin, clientId, fetchImpl, timeoutMs) {
  return fetchWithTimeout(fetchImpl, `${origin}/oauth/authorize_device`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, scope: 'api' }),
  }, timeoutMs);
}

const cliCapability = (available) => {
  const capability = { available };
  if (!available) capability.reason = 'cli-unavailable';
  return capability;
};

export async function probeGitLabAuth({ origin, clientId, fetch: fetchImpl = fetch, timeoutMs = 10_000, glabAvailable = false }) {
  let versionResponse;
  try {
    versionResponse = await fetchWithTimeout(fetchImpl, `${origin}/api/v4/version`, { headers: { Accept: 'application/json' } }, timeoutMs);
  } catch (error) {
    throw new GitLabRequestError('unreachable', error?.message || 'GitLab instance is unreachable');
  }
  // Rate limiting and server errors say nothing about whether this is GitLab.
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
    throw new GitLabRequestError('unreachable', error?.message || 'GitLab instance is unreachable');
  }
  const payload = await readJson(response);
  if (response.ok) return { confirmed: true, device: { available: true }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (response.status === 404 || response.status === 405) return { confirmed: true, device: { available: false, reason: 'unsupported' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (payload?.error === 'invalid_client') return { confirmed: true, device: { available: false, reason: 'invalid-client' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
  if (response.status === 429 || response.status >= 500) throw new GitLabRequestError('temporarily-unavailable', 'GitLab authentication is temporarily unavailable', response.status);
  return { confirmed: true, device: { available: false, reason: 'provider-error' }, pat: { available: true }, cli: cliCapability(glabAvailable) };
}

export async function startGitLabDeviceFlow({ origin, clientId, fetch: fetchImpl = fetch, timeoutMs = 10_000 }) {
  const response = await requestDeviceAuthorization(origin, clientId, fetchImpl, timeoutMs);
  const payload = await readJson(response);
  if (!response.ok) {
    const kind = response.status === 429 || response.status >= 500 ? 'temporarily-unavailable' : 'provider-error';
    throw new GitLabRequestError(kind, payload?.error_description || payload?.error || 'Failed to start GitLab device flow', response.status);
  }
  if (!isString(payload?.device_code) || !isString(payload.user_code) || !isString(payload.verification_uri)
    || !Number.isFinite(payload.expires_in) || !Number.isFinite(payload.interval)) throw new GitLabRequestError('provider-error', 'Invalid GitLab device flow response');
  return payload;
}

export async function exchangeGitLabDeviceCode({ origin, clientId, deviceCode, fetch: fetchImpl = fetch, timeoutMs = 10_000 }) {
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

/**
 * What keeps an OAuth sign-in alive. GitLab access tokens expire after two
 * hours; the refresh token trades for a new pair before then. Absent fields
 * mean a token that does not expire.
 */
function renewal(payload) {
  const result = {};
  if (isString(payload?.refresh_token) && payload.refresh_token) result.refreshToken = payload.refresh_token;
  if (Number.isFinite(payload?.expires_in) && payload.expires_in > 0) result.expiresIn = payload.expires_in;
  return result;
}

/**
 * Trades a refresh token for a new access token. GitLab rotates the refresh
 * token too, so the old one is spent once this succeeds. A rejected grant is
 * an invalid sign-in; anything else is the instance being unavailable.
 */
export async function refreshGitLabAccessToken({ origin, clientId, refreshToken, fetch: fetchImpl = fetch, timeoutMs = 10_000 }) {
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
