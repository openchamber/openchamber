import { isString } from '../shared/guards.js';
import { readBoundedResponseText } from '../shared/response-body.js';

const GITHUB_AUTH_BODY_MAX_BYTES = 1 * 1024 * 1024;

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const encodeForm = (params) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  return body.toString();
};

async function postForm(url, params, { fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: encodeForm(params),
  });

  const read = await readBoundedResponseText(response, GITHUB_AUTH_BODY_MAX_BYTES);
  if (read.tooLarge) {
    // An over-cap answer must throw, not return null: exchangeDeviceCode
    // would otherwise silently succeed-null on a 200 over-cap answer.
    // No payload is attached — the body was not parsed whole.
    const error = new Error(`GitHub auth response exceeded ${GITHUB_AUTH_BODY_MAX_BYTES} bytes`);
    error.status = response.status;
    throw error;
  }
  let payload = null;
  try {
    // Response.json() strips a leading UTF-8 BOM; the bounded reader
    // does not, so strip it here like the GitLab twin does.
    payload = JSON.parse(read.text.replace(/^\uFEFF/, ''));
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || response.statusText;
    const error = new Error(message || 'GitHub request failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function startDeviceFlow({ clientId, scope, fetch: fetchImpl, timeoutMs }) {
  const payload = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  }, { fetch: fetchImpl, timeoutMs });
  if (!isString(payload?.device_code) || !payload.device_code
    || !isString(payload.user_code) || !payload.user_code
    || !isString(payload.verification_uri) || !payload.verification_uri
    || !Number.isFinite(payload.expires_in) || !Number.isFinite(payload.interval)) {
    throw new Error('Invalid GitHub device flow response');
  }
  return payload;
}

export async function exchangeDeviceCode({ clientId, deviceCode, fetch: fetchImpl, timeoutMs }) {
  // GitHub returns 200 with {error: 'authorization_pending'|...} for non-success states.
  return postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  }, { fetch: fetchImpl, timeoutMs });
}
