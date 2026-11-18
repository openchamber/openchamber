import { isString } from '../shared/guards.js';
import { hasProperty } from './contracts.js';
import type { GitHubEnvelope } from './contracts.js';

interface RequestOptions {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

interface DeviceGrant extends GitHubEnvelope {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

const isDeviceGrant = (payload: unknown): payload is DeviceGrant =>
  hasProperty(payload, 'device_code') && isString(payload.device_code) && Boolean(payload.device_code)
  && hasProperty(payload, 'user_code') && isString(payload.user_code) && Boolean(payload.user_code)
  && hasProperty(payload, 'verification_uri') && isString(payload.verification_uri) && Boolean(payload.verification_uri)
  && hasProperty(payload, 'expires_in') && Number.isFinite(payload.expires_in)
  && hasProperty(payload, 'interval') && Number.isFinite(payload.interval);

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const encodeForm = (params: Record<string, string | null | undefined>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  return body.toString();
};

async function postForm(url: string, params: Record<string, string | null | undefined>, { fetch: fetchImpl = fetch, timeoutMs = 10_000 }: RequestOptions = {}) {
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

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (hasProperty(payload, 'error_description') ? payload.error_description : undefined)
      || (hasProperty(payload, 'error') ? payload.error : undefined) || response.statusText;
    const error = Object.assign(new Error(String(message || 'GitHub request failed')), { status: response.status, payload });
    throw error;
  }
  return payload;
}

export async function startDeviceFlow({ clientId, scope, fetch: fetchImpl, timeoutMs }: RequestOptions & { clientId: string; scope: string }) {
  const payload = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  }, { fetch: fetchImpl, timeoutMs });
  if (!isDeviceGrant(payload)) {
    throw new Error('Invalid GitHub device flow response');
  }
  return payload;
}

export async function exchangeDeviceCode({ clientId, deviceCode, fetch: fetchImpl, timeoutMs }: RequestOptions & { clientId: string; deviceCode: string }) {
  return postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  }, { fetch: fetchImpl, timeoutMs });
}
