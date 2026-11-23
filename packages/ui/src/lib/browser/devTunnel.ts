import { invokeDesktopCommand, listenForDesktopRelayDevTunnels, postDesktopRelayDevTunnelMessage } from '@/lib/desktopNative';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getActiveRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeApiBaseUrl, getRuntimeKey, isSshForwardedRuntime, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { spaceIdOfDirectory, spaceRootDirectory } from '@/lib/spaces/space-route';
import { DEV_TUNNEL_HOSTNAME, framableUrl, isLoopbackUrl } from './url';
import { isCapacitorApp } from '@/lib/platform';
import { openMobileDevTunnel, closeMobileDevTunnels } from './mobileDevTunnel';

type TunnelResult = { localPort: number };

const localPortByTarget = new Map<string, number>();
const pendingMobilePorts = new Map<string, Promise<number>>();
let mobileTunnelGeneration = 0;
const originByLocalPort = new Map<number, string>();
const relaySockets = new Map<string, RelayTunnelWebSocket>();
const pendingRelayConnections = new Set<string>();

const tunnelPath = (spaceId: string | null, port: number): string => (
  spaceId
    ? `/api/dev-tunnel?port=${port}&directory=${encodeURIComponent(spaceRootDirectory(spaceId))}`
    : `/api/dev-tunnel?port=${port}`
);

const openRelayConnection = async (connectionId: string, remotePort: number, spaceId: string | null): Promise<void> => {
  if (!getActiveRelayTunnel()) {
    pendingRelayConnections.delete(connectionId);
    postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
    return;
  }
  await refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl());
  if (!pendingRelayConnections.has(connectionId) || !getActiveRelayTunnel()) return;
  const url = getRuntimeUrlResolver().websocket(tunnelPath(spaceId, remotePort));
  const socket = openRuntimeWebSocket(url);
  relaySockets.set(connectionId, socket);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => postDesktopRelayDevTunnelMessage(connectionId, { type: 'ready' });
  socket.onmessage = (event) => postDesktopRelayDevTunnelMessage(connectionId, { type: 'data', data: event.data instanceof ArrayBuffer ? event.data : new TextEncoder().encode(event.data) });
  socket.onerror = () => postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
  socket.onclose = () => {
    pendingRelayConnections.delete(connectionId);
    relaySockets.delete(connectionId);
    postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
  };
};

listenForDesktopRelayDevTunnels(({ connectionId, remotePort, spaceId, message }) => {
  switch (message.type) {
    case 'data': {
      const socket = relaySockets.get(connectionId);
      if (socket && message.data) socket.send(message.data);
      return;
    }
    case 'close':
      pendingRelayConnections.delete(connectionId);
      relaySockets.get(connectionId)?.close();
      relaySockets.delete(connectionId);
      return;
    case 'connect':
      pendingRelayConnections.add(connectionId);
      void openRelayConnection(connectionId, remotePort, spaceId).catch(() => {
        pendingRelayConnections.delete(connectionId);
        postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
      });
  }
});

const isDesktopRuntime = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

const localOrigin = (): string => globalThis.window?.__OPENCHAMBER_LOCAL_ORIGIN__ ?? '';

const isRemoteRuntime = (baseUrl: string): boolean => {
  if (!baseUrl) return false;
  if (isRelayModeActive()) return true;
  try {
    const parsed = new URL(baseUrl, typeof window !== 'undefined' ? window.location.href : undefined);
    const localOrigin = typeof window !== 'undefined' ? window.__OPENCHAMBER_LOCAL_ORIGIN__ : '';
    if (localOrigin && parsed.origin === localOrigin) return false;
    if (isDesktopRuntime() && isSshForwardedRuntime()) return true;
    return !isLoopbackUrl(parsed.toString());
  } catch {
    return false;
  }
};

export const isRemoteWebLoopbackUrl = (url: string, directory?: string | null): boolean => {
  if (!url || isDesktopRuntime() || !isLoopbackUrl(url) || !globalThis.window) return false;
  if (spaceIdOfDirectory(directory) !== null) return true;
  return isRemoteRuntime(getRuntimeApiBaseUrl() || globalThis.window.location.href);
};

export const isSpaceUnreachableFromHere = (directory: string | null | undefined): boolean => (
  spaceIdOfDirectory(directory) !== null && !isDesktopRuntime() && !isCapacitorApp()
);

export const resolveIframeBrowserUrl = (url: string, directory?: string | null): string => (
  isRemoteWebLoopbackUrl(url, directory) ? '' : framableUrl(url)
);

export const reachesDevServersThroughTunnel = (): boolean => (
  isDesktopRuntime() && isRemoteRuntime(getRuntimeApiBaseUrl())
);

const loopbackPort = (url: string): number => {
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
};

const rewriteToLocalPort = (url: string, localPort: number, mobile = false): string => {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'http:';
    parsed.hostname = mobile ? '127.0.0.1' : DEV_TUNNEL_HOSTNAME;
    parsed.port = String(localPort);
    return parsed.toString();
  } catch {
    return url;
  }
};

const rememberOriginalOrigin = (url: string, localPort: number): void => {
  try {
    originByLocalPort.set(localPort, new URL(url).origin);
  } catch {
    // Unparseable input never reaches here; nothing to record.
  }
};

export class DevTunnelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevTunnelUnavailableError';
  }
}

export const resolveBrowsableUrl = async (url: string, directory?: string | null): Promise<string> => {
  if (!url || (!isDesktopRuntime() && !isCapacitorApp()) || !isLoopbackUrl(url)) return url;

  const spaceId = spaceIdOfDirectory(directory);
  const baseUrl = getRuntimeApiBaseUrl() || (spaceId !== null ? localOrigin() : '');
  if (spaceId === null && !isRemoteRuntime(baseUrl)) return url;

  const port = loopbackPort(url);
  if (!port) return url;

  const key = `${baseUrl}|${spaceId ?? ''}|${port}`;
  const cached = localPortByTarget.get(key);
  if (cached) {
    rememberOriginalOrigin(url, cached);
    return rewriteToLocalPort(url, cached, isCapacitorApp());
  }

  try {
    if (isCapacitorApp()) {
      let pendingPort = pendingMobilePorts.get(key);
      if (!pendingPort) {
        let openedPort = 0;
        pendingPort = openMobileDevTunnel(tunnelPath(spaceId, port), () => {
          if (!openedPort || localPortByTarget.get(key) !== openedPort) return;
          localPortByTarget.delete(key);
          originByLocalPort.delete(openedPort);
        }).then((value) => {
          openedPort = value;
          return value;
        });
        pendingMobilePorts.set(key, pendingPort);
      }
      try {
        const generation = mobileTunnelGeneration;
        const mobilePort = await pendingPort;
        if (generation !== mobileTunnelGeneration) throw new DevTunnelUnavailableError(url);
        localPortByTarget.set(key, mobilePort);
        rememberOriginalOrigin(url, mobilePort);
        return rewriteToLocalPort(url, mobilePort, true);
      } finally {
        if (pendingMobilePorts.get(key) === pendingPort) pendingMobilePorts.delete(key);
      }
    }
    const result = await invokeDesktopCommand<TunnelResult>('desktop_dev_tunnel_open', {
      baseUrl,
      port,
      spaceId,
      relay: isRelayModeActive(),
      targetKey: getRuntimeKey(),
      clientToken: getRuntimeBearerTokenSync(),
      requestHeaders: getRuntimeExtraHeadersSync(),
    });
    if (!result || !Number.isInteger(result.localPort) || result.localPort <= 0) {
      throw new DevTunnelUnavailableError(url);
    }
    localPortByTarget.set(key, result.localPort);
    rememberOriginalOrigin(url, result.localPort);
    return rewriteToLocalPort(url, result.localPort);
  } catch (error) {
    if (error instanceof DevTunnelUnavailableError) throw error;
    throw new DevTunnelUnavailableError(url);
  }
};

export const shouldTunnelLoopbackUrl = (url: string, directory?: string | null): boolean => {
  if (!url || !isDesktopRuntime() || !isLoopbackUrl(url)) return false;
  if (spaceIdOfDirectory(directory) === null && !isRemoteRuntime(getRuntimeApiBaseUrl())) return false;
  const port = loopbackPort(url);
  return port > 0 && !originByLocalPort.has(port);
};

export const toDisplayUrl = (url: string): string => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== DEV_TUNNEL_HOSTNAME && parsed.hostname !== '127.0.0.1') return url;
    const origin = originByLocalPort.get(Number.parseInt(parsed.port || '0', 10));
    if (!origin) return url;
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
};

const resetDevTunnelCache = (): void => {
  localPortByTarget.clear();
  pendingMobilePorts.clear();
  mobileTunnelGeneration += 1;
  originByLocalPort.clear();
  pendingRelayConnections.clear();
  for (const socket of relaySockets.values()) socket.close();
  relaySockets.clear();
  closeMobileDevTunnels();
  if (isDesktopRuntime()) void invokeDesktopCommand('desktop_relay_dev_tunnel_close_all').catch(() => {});
};

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(resetDevTunnelCache);
}
