import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

const localRuntimePlan = ({ localUiUrl, localUrl, localClientToken = '' }) => ({
  initialUrl: localUiUrl,
  apiBaseUrl: localUrl,
  clientToken: localClientToken,
  requestHeaders: {},
  relayHostId: '',
  probeRemote: false,
});

const isHttpRuntimeUrl = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const planRuntimeForHost = ({
  hostId,
  hosts = [],
  localUiUrl,
  localUrl,
  localClientToken = '',
  useRemoteUi = false,
} = {}) => {
  const localPlan = localRuntimePlan({ localUiUrl, localUrl, localClientToken });
  if (hostId === 'local') return localPlan;
  if (!hostId) return null;

  const host = hosts.find((entry) => entry.id === hostId);
  if (!host) return null;

  const encrypted = (host.relay && typeof host.relay === 'object')
    || (host.directE2ee && typeof host.directE2ee === 'object');
  const directUrl = host.apiUrl || host.url;
  const hasDirect = isHttpRuntimeUrl(directUrl);
  if (encrypted) {
    return {
      ...localPlan,
      ...(hasDirect ? {
        apiBaseUrl: directUrl,
        clientToken: host.clientToken || '',
        requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
        probeRemote: true,
      } : {}),
      relayHostId: host.id,
    };
  }
  if (!hasDirect) return null;

  return {
    initialUrl: useRemoteUi ? (host.url || directUrl) : localUiUrl,
    apiBaseUrl: directUrl,
    clientToken: host.clientToken || '',
    requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
    relayHostId: '',
    probeRemote: true,
  };
};

export const planInitialRuntime = ({
  envTarget = '',
  defaultHostId = '',
  hosts = [],
  localUiUrl,
  localUrl,
  localClientToken = '',
  useRemoteUi = false,
} = {}) => {
  const localPlan = localRuntimePlan({ localUiUrl, localUrl, localClientToken });

  if (envTarget) {
    return {
      ...localPlan,
      initialUrl: useRemoteUi ? envTarget : localUiUrl,
      apiBaseUrl: envTarget,
      clientToken: '',
      probeRemote: true,
    };
  }

  if (!defaultHostId) return localPlan;
  return planRuntimeForHost({ hostId: defaultHostId, hosts, localUiUrl, localUrl, localClientToken, useRemoteUi }) || localPlan;
};
