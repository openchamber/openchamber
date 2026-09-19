import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { installRuntimeFetchBridge } from '@openchamber/ui/lib/runtime-fetch';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@openchamber/ui/lib/runtime-switch';
import { warmDesktopHostStatuses } from '@openchamber/ui/lib/desktopHostStatus';
import { restoreDesktopRelayRuntime } from '@openchamber/ui/lib/desktopRelayRestore';
import { getInjectedBootOutcome } from '@openchamber/ui/lib/desktopBoot';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import type { EmbeddedSessionRuntimeBootstrap } from '@openchamber/ui/components/layout/contextPanelEmbeddedChat';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';
import { createWebAPIs } from './api';

// The switcher's statuses are warmed after boot settles, not during it.
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
    __OPENCHAMBER_RUNTIME_BOOTSTRAP_READY__?: boolean;
  }
}

export const DESKTOP_RUNTIME_BOOTSTRAP_READY_EVENT = 'openchamber:runtime-bootstrap-ready';
const DESKTOP_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * The Electron main process creates the splash window before its asynchronous
 * startup probe finishes. Wait for the main-process init script to publish the
 * resolved endpoint before importing the shared app, otherwise the first boot
 * can initialize against the local relative API and ignore the default host.
 */
export const waitForDesktopRuntimeBootstrap = async (): Promise<void> => {
  const currentWindow = globalThis.window;
  if (!currentWindow?.__OPENCHAMBER_ELECTRON__) return;
  if (currentWindow.__OPENCHAMBER_RUNTIME_BOOTSTRAP_READY__ === true) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      currentWindow.removeEventListener(DESKTOP_RUNTIME_BOOTSTRAP_READY_EVENT, finish);
      if (timeoutId !== undefined) currentWindow.clearTimeout(timeoutId);
      resolve();
    };

    currentWindow.addEventListener(DESKTOP_RUNTIME_BOOTSTRAP_READY_EVENT, finish, { once: true });
    const timeoutId = currentWindow.setTimeout(finish, DESKTOP_RUNTIME_BOOTSTRAP_TIMEOUT_MS);
  });
};

export const readRuntimeBootstrapConfig = (): EmbeddedSessionRuntimeBootstrap => {
  const readString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

  return {
    apiBaseUrl: readString(window.__OPENCHAMBER_API_BASE_URL__),
    clientToken: readString(window.__OPENCHAMBER_CLIENT_TOKEN__),
    localOrigin: readString(window.__OPENCHAMBER_LOCAL_ORIGIN__),
    runtimeHeaders: window.__OPENCHAMBER_RUNTIME_HEADERS__,
    relayHostId: readString(window.__OPENCHAMBER_RELAY_HOST_ID__),
  };
};

// Resolved once the desktop relay-host restore (if any) has picked a transport.
// Immediately-resolved everywhere else. See createConfiguredWebAPIs.
let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = (bootstrap?: EmbeddedSessionRuntimeBootstrap | null) => {
  const { apiBaseUrl, clientToken, localOrigin, runtimeHeaders, relayHostId, relay } = bootstrap ?? readRuntimeBootstrapConfig();
  const bootOutcome = bootstrap ? null : getInjectedBootOutcome();
  const desktopHostId = relayHostId || (bootOutcome?.target === 'remote' ? bootOutcome.hostId : '');

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: sameOrigin(apiBaseUrl, localOrigin) ? 'local' : (desktopHostId ? `host:${desktopHostId}` : null),
  });
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(runtimeHeaders || null);
  if (relay) {
    switchRuntimeEndpoint({
      apiBaseUrl,
      clientToken: clientToken || null,
      requestHeaders: runtimeHeaders || null,
      runtimeKey: relayHostId ? `host:${relayHostId}` : null,
      relay,
    });
  }
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
  desktopRelayRestoreReady = relay
    ? Promise.resolve()
    : Promise.race([
        restoreDesktopRelayRuntime(relayHostId || undefined).catch(() => {}),
        // Never hold the app hostage: a stuck probe/tunnel gives up to the UI.
        new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
      ]).then(() => {
        // Relay-capable windows may select a reachable direct leg before React
        // subscribes to runtime-change events, so bind the SDK explicitly.
        opencodeClient.reconnectToRuntimeBaseUrl();
      });
  // Learn every instance's reachability in the background, so the switcher opens
  // on real values instead of probing for the first time under the user's
  // cursor. After the endpoint is settled and past the app's own bootstrap:
  // this is unprompted work and the machine's network is busiest at launch.
  void desktopRelayRestoreReady.then(() => {
    window.setTimeout(() => { void warmDesktopHostStatuses().catch(() => {}); }, HOST_STATUS_WARMUP_DELAY_MS);
  });
  const runtimeApis = createWebAPIs({ urls });
  // The shared SDK is created during module initialization, before this runtime
  // configuration is applied. Rebind it after the web APIs are initialized so
  // an external runtime cannot leave that client pointed at the UI origin.
  opencodeClient.reconnectToRuntimeBaseUrl();
  return runtimeApis;
};
