import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { installRuntimeFetchBridge } from '@openchamber/ui/lib/runtime-fetch';
import { initializeRuntimeEndpoint } from '@openchamber/ui/lib/runtime-switch';
import { restoreDesktopRelayRuntime } from '@openchamber/ui/lib/desktopRelayRestore';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createWebAPIs } from './api';

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
  }
}

// Resolved once the desktop relay-host restore (if any) has picked a transport.
// Immediately-resolved everywhere else. See createConfiguredWebAPIs.
let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = () => {
  const apiBaseUrl = typeof window.__OPENCHAMBER_API_BASE_URL__ === 'string'
    ? window.__OPENCHAMBER_API_BASE_URL__.trim()
    : '';
  const clientToken = typeof window.__OPENCHAMBER_CLIENT_TOKEN__ === 'string'
    ? window.__OPENCHAMBER_CLIENT_TOKEN__.trim()
    : '';
  const localOrigin = typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string'
    ? window.__OPENCHAMBER_LOCAL_ORIGIN__.trim()
    : '';

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: sameOrigin(apiBaseUrl, localOrigin) ? 'local' : null,
  });
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(window.__OPENCHAMBER_RUNTIME_HEADERS__ || null);
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();
  // Desktop only: reconnect a relay-capable host now that the fetch bridge is
  // installed — either the host this window was opened for (injected id) or the
  // default host on relaunch. No-op elsewhere; resolves in milliseconds when no
  // relay host is involved. main.tsx holds the app render on this promise so
  // the user sees the splash instead of a transient auth screen against an
  // endpoint that is still being selected.
  const relayHostId = (window as typeof window & { __OPENCHAMBER_RELAY_HOST_ID__?: string }).__OPENCHAMBER_RELAY_HOST_ID__;
  desktopRelayRestoreReady = Promise.race([
    restoreDesktopRelayRuntime(typeof relayHostId === 'string' && relayHostId ? relayHostId : undefined).catch(() => {}),
    // Never hold the app hostage: a stuck probe/tunnel gives up to the UI.
    new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
  ]);
  return createWebAPIs({ urls });
};
