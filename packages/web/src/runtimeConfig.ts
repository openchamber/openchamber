import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { installRuntimeFetchBridge } from '@openchamber/ui/lib/runtime-fetch';
import { getRuntimeKey, initializeRuntimeEndpoint, subscribeRuntimeEndpointChanged } from '@openchamber/ui/lib/runtime-switch';
import { warmDesktopHostStatuses } from '@openchamber/ui/lib/desktopHostStatus';
import { restoreDesktopRelayRuntime } from '@openchamber/ui/lib/desktopRelayRestore';
import { getInjectedBootOutcome } from '@openchamber/ui/lib/desktopBoot';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';
import { createWebAPIs } from './api';


const HOST_STATUS_WARMUP_DELAY_MS = 3_000;

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

declare global {
  interface Window {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_CLIENT_TOKEN__?: string;
    __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_RELAY_HOST_ID__?: string;
    __OPENCHAMBER_EXPLICIT_RUNTIME__?: boolean;

    __OPENCHAMBER_DESKTOP__?: {
      invoke?: (cmd: string, args?: Record<string, string>) => Promise<void>;
    };
  }
}

type RuntimeBootstrapConfig = {
  apiBaseUrl: string;
  clientToken: string;
  localOrigin: string;
  runtimeHeaders?: Record<string, string>;
  relayHostId: string;
  explicitRuntime: boolean;
};

export const readRuntimeBootstrapConfig = (): RuntimeBootstrapConfig => {
  const readString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

  return {
    apiBaseUrl: readString(window.__OPENCHAMBER_API_BASE_URL__),
    clientToken: readString(window.__OPENCHAMBER_CLIENT_TOKEN__),
    localOrigin: readString(window.__OPENCHAMBER_LOCAL_ORIGIN__),
    runtimeHeaders: window.__OPENCHAMBER_RUNTIME_HEADERS__,
    relayHostId: readString(window.__OPENCHAMBER_RELAY_HOST_ID__),
    explicitRuntime: window.__OPENCHAMBER_EXPLICIT_RUNTIME__ === true,
  };
};



let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = () => {
  const { apiBaseUrl, clientToken, localOrigin, runtimeHeaders, relayHostId, explicitRuntime } = readRuntimeBootstrapConfig();
  const bootOutcome = getInjectedBootOutcome();
  const desktopHostId = relayHostId || (bootOutcome?.target === 'remote' ? bootOutcome.hostId : '');

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: sameOrigin(apiBaseUrl, localOrigin) ? 'local' : (desktopHostId ? `host:${desktopHostId}` : null),
  });






  const reportWindowRuntimeKey = (runtimeKey: string): void => {
    const key = runtimeKey.trim();
    const invoke = window.__OPENCHAMBER_DESKTOP__?.invoke;
    if (!key || !invoke) return;
    void invoke('desktop_set_window_runtime_key', { runtimeKey: key }).catch(() => {});
  };
  reportWindowRuntimeKey(getRuntimeKey());
  subscribeRuntimeEndpointChanged((detail) => reportWindowRuntimeKey(detail.runtimeKey));
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(runtimeHeaders || null);


  opencodeClient.reconnectToRuntimeBaseUrl();
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();





  const restoreRelayRuntime = (): Promise<void> => {


    if (relayHostId) return restoreDesktopRelayRuntime(relayHostId, { reconnectActive: true });

    if (explicitRuntime) return Promise.resolve();

    return restoreDesktopRelayRuntime();
  };
  desktopRelayRestoreReady = Promise.race([
    restoreRelayRuntime().catch(() => {}),

    new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
  ]).then(() => {


    opencodeClient.reconnectToRuntimeBaseUrl();
  });




  void desktopRelayRestoreReady.then(() => {
    window.setTimeout(() => { void warmDesktopHostStatuses().catch(() => {}); }, HOST_STATUS_WARMUP_DELAY_MS);
  });
  return createWebAPIs({ urls });
};
