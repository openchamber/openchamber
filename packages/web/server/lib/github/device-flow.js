const DEFAULT_GITHUB_BASE_URL = 'https://github.com';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const encodeForm = (params) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  return body.toString();
};

async function postForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: encodeForm(params),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || response.statusText;
    const error = new Error(message || 'GitHub request failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const normalizeBaseUrl = (baseUrl) => {
  const candidate = typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim()
    : DEFAULT_GITHUB_BASE_URL;
  const parsed = new URL(candidate);
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
};

const resolveDeviceCodeUrl = (baseUrl) => `${normalizeBaseUrl(baseUrl)}/login/device/code`;
const resolveAccessTokenUrl = (baseUrl) => `${normalizeBaseUrl(baseUrl)}/login/oauth/access_token`;

export async function startDeviceFlow({ clientId, scope, baseUrl }) {
  return postForm(resolveDeviceCodeUrl(baseUrl), {
    client_id: clientId,
    scope,
  });
}

export async function exchangeDeviceCode({ clientId, deviceCode, baseUrl }) {
  // GitHub returns 200 with {error: 'authorization_pending'|...} for non-success states.
  const payload = await postForm(resolveAccessTokenUrl(baseUrl), {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  });
  return payload;
}
