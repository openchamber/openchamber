import { exchangeDeviceCode, startDeviceFlow } from '../github/device-flow.js';
import { readAuthFile, writeAuthFile } from './auth.js';

export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';

const COPILOT_PROVIDER_ID = 'github-copilot';

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

export const resolveCopilotGheClientId = (clientId) => {
  const normalized = normalizeString(clientId);
  return normalized || DEFAULT_GITHUB_CLIENT_ID;
};

export const normalizeCopilotGheEnterpriseHost = (serverUrl) => {
  const normalized = normalizeString(serverUrl);
  if (!normalized) {
    throw new Error('serverUrl is required');
  }

  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('serverUrl is invalid');
  }

  if (!parsed.hostname) {
    throw new Error('serverUrl is invalid');
  }

  return parsed.host.toLowerCase();
};

const getBaseUrlForHost = (enterpriseHost) => `https://${enterpriseHost}`;

export const startCopilotGheAuthFlow = async ({ serverUrl, clientId }) => {
  const enterpriseHost = normalizeCopilotGheEnterpriseHost(serverUrl);
  const resolvedClientId = resolveCopilotGheClientId(clientId);
  const payload = await startDeviceFlow({
    clientId: resolvedClientId,
    baseUrl: getBaseUrlForHost(enterpriseHost),
  });
  return {
    enterpriseHost,
    clientId: resolvedClientId,
    payload,
  };
};

export const completeCopilotGheAuthFlow = async ({ serverUrl, clientId, deviceCode }) => {
  const enterpriseHost = normalizeCopilotGheEnterpriseHost(serverUrl);
  const resolvedClientId = resolveCopilotGheClientId(clientId);
  const payload = await exchangeDeviceCode({
    clientId: resolvedClientId,
    deviceCode,
    baseUrl: getBaseUrlForHost(enterpriseHost),
  });

  return {
    enterpriseHost,
    clientId: resolvedClientId,
    payload,
  };
};

export const writeCopilotGheAuthToken = ({ enterpriseHost, accessToken }) => {
  const auth = readAuthFile();
  auth[COPILOT_PROVIDER_ID] = {
    type: 'oauth',
    access: accessToken,
    refresh: '',
    // Far-future expiry: the GHE OAuth token does not expire on its own.
    // OpenCode requires this field; a value of 0 would immediately trigger
    // a (failing) refresh attempt.
    expires: 9999999999999,
    enterpriseUrl: enterpriseHost,
  };
  writeAuthFile(auth);
};
