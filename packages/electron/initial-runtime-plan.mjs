import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

export const planInitialRuntime = ({
  envTarget = '',
  defaultHostId = '',
  hosts = [],
  localUiUrl,
  localUrl,
  localClientToken = '',
  useRemoteUi = false,
} = {}) => {
  const localPlan = {
    initialUrl: localUiUrl,
    apiBaseUrl: localUrl,
    clientToken: localClientToken,
    requestHeaders: {},
    relayHostId: '',
    probeRemote: false,
  };

  if (envTarget) {
    return {
      ...localPlan,
      initialUrl: useRemoteUi ? envTarget : localUiUrl,
      apiBaseUrl: envTarget,
      clientToken: '',
      probeRemote: true,
    };
  }

  if (!defaultHostId || defaultHostId === 'local') return localPlan;

  const host = hosts.find((entry) => entry.id === defaultHostId);
  if (!host) return localPlan;

  if ((host.relay && typeof host.relay === 'object') || (host.directE2ee && typeof host.directE2ee === 'object')) {
    return { ...localPlan, relayHostId: host.id };
  }

  if (!host.url) return localPlan;

  return {
    initialUrl: useRemoteUi ? host.url : localUiUrl,
    apiBaseUrl: host.apiUrl || host.url,
    clientToken: host.clientToken || '',
    requestHeaders: sanitizeRuntimeRequestHeaders(host.requestHeaders || {}),
    relayHostId: '',
    probeRemote: true,
  };
};
