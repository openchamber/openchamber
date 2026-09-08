/**
 * Makes a remote dev server browsable from the desktop app.
 *
 * A URL like `http://localhost:5173` means "this machine" to whoever resolves
 * it. When OpenChamber is running on another host, that is the wrong machine:
 * the dev server is on the host, the browser is here. The desktop shell binds
 * an equivalent local port and pipes it to the host, so the same page loads
 * from a real local origin with nothing rewritten.
 *
 * Everywhere else — local runtime, web, mobile — the URL is already correct and
 * is returned untouched.
 */
import { invokeDesktopCommand, listenForDesktopRelayDevTunnels, postDesktopRelayDevTunnelMessage } from '@/lib/desktopNative';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getActiveRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isLoopbackUrl } from './url';

type TunnelResult = { localPort: number };

/** Keyed by `${baseUrl}|${port}`; the shell owns the real lifetime. */
const localPortByTarget = new Map<string, number>();
/** Reverse map, so a tunnel port never leaks into the address bar or storage. */
const originByLocalPort = new Map<number, string>();
const relaySockets = new Map<string, RelayTunnelWebSocket>();
const pendingRelayConnections = new Set<string>();

const openRelayConnection = async (connectionId: string, remotePort: number): Promise<void> => {
  if (!getActiveRelayTunnel()) {
    pendingRelayConnections.delete(connectionId);
    postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
    return;
  }
  await refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl());
  if (!pendingRelayConnections.has(connectionId) || !getActiveRelayTunnel()) return;
  const url = getRuntimeUrlResolver().websocket(`/api/dev-tunnel?port=${remotePort}`);
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

listenForDesktopRelayDevTunnels(({ connectionId, remotePort, message }) => {
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
      void openRelayConnection(connectionId, remotePort).catch(() => {
        pendingRelayConnections.delete(connectionId);
        postDesktopRelayDevTunnelMessage(connectionId, { type: 'close' });
      });
  }
});

const isDesktopRuntime = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

/**
 * True when the app is talking to an OpenChamber on another machine. A local
 * runtime resolves loopback URLs correctly on its own and must not be tunneled,
 * which would only add a hop.
 */
const isRemoteRuntime = (baseUrl: string): boolean => {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl, typeof window !== 'undefined' ? window.location.href : undefined);
    const localOrigin = typeof window !== 'undefined' ? window.__OPENCHAMBER_LOCAL_ORIGIN__ : '';
    if (localOrigin && parsed.origin === localOrigin) return false;
    return !isLoopbackUrl(parsed.toString());
  } catch {
    return false;
  }
};

/**
 * The port a loopback URL addresses, including the one it leaves implicit.
 * Both callers must agree on this: an omitted port is 80 or 443, not nothing.
 */
const loopbackPort = (url: string): number => {
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
};

const rewriteToLocalPort = (url: string, localPort: number): string => {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'http:';
    parsed.hostname = '127.0.0.1';
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

/** Thrown when a remote dev server exists but could not be reached from here. */
export class DevTunnelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevTunnelUnavailableError';
  }
}

/**
 * Returns the URL the browser view should actually load.
 *
 * A failure to tunnel is reported rather than papered over. Loading the
 * original loopback URL instead would not be "the same outcome without this
 * mechanism": on a remote instance it changes which machine answers, so the
 * user would be shown whatever happens to run on that port here — possibly a
 * different application — under the address they asked for. The refusal is
 * often authoritative, too: discovery unavailable, port not offered,
 * authentication rejected. None of that should look like a page.
 */
export const resolveBrowsableUrl = async (url: string): Promise<string> => {
  if (!url || !isDesktopRuntime() || !isLoopbackUrl(url)) return url;

  const baseUrl = getRuntimeApiBaseUrl();
  if (!isRemoteRuntime(baseUrl)) return url;

  const port = loopbackPort(url);
  if (!port) return url;

  const key = `${baseUrl}|${port}`;
  const cached = localPortByTarget.get(key);
  if (cached) {
    rememberOriginalOrigin(url, cached);
    return rewriteToLocalPort(url, cached);
  }

  try {
    const result = await invokeDesktopCommand<TunnelResult>('desktop_dev_tunnel_open', {
      baseUrl,
      port,
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

/**
 * True when a loopback URL belongs to the machine OpenChamber runs on rather
 * than to this one.
 *
 * A page served through a tunnel can send the browser to another local port —
 * a docs server behind a dev gateway, an API on its own port — and that
 * navigation happens inside the view, where nothing resolved it. Without this
 * the address would be looked for on the user's own machine, where it is either
 * nothing at all or, worse, a different application.
 *
 * A URL already pointing at a tunnel's local port is not retargeted; that one
 * is this machine, deliberately.
 */
export const shouldTunnelLoopbackUrl = (url: string): boolean => {
  if (!url || !isDesktopRuntime() || !isLoopbackUrl(url)) return false;
  if (!isRemoteRuntime(getRuntimeApiBaseUrl())) return false;
  const port = loopbackPort(url);
  return port > 0 && !originByLocalPort.has(port);
};

/**
 * Maps a URL the view actually loaded back to the address the user asked for.
 *
 * Without this the tunnel's random local port would show up in the address bar
 * and, worse, be persisted as the tab's target — a port that means nothing
 * after a restart.
 */
export const toDisplayUrl = (url: string): string => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') return url;
    const origin = originByLocalPort.get(Number.parseInt(parsed.port || '0', 10));
    if (!origin) return url;
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
};

/**
 * Forgets cached tunnels. Cache entries are keyed by runtime base URL, so a
 * switch does not make them wrong — but the shell's listeners belong to the
 * previous endpoint, and holding their ports would keep resolving URLs to a
 * host the user has left.
 */
const resetDevTunnelCache = (): void => {
  localPortByTarget.clear();
  originByLocalPort.clear();
  pendingRelayConnections.clear();
  for (const socket of relaySockets.values()) socket.close();
  relaySockets.clear();
  void invokeDesktopCommand('desktop_relay_dev_tunnel_close_all').catch(() => {});
};

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(resetDevTunnelCache);
}
