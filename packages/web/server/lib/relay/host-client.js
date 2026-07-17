// Long-lived relay host client: maintains the signed `host-control` socket to
// the relay, and per connected client a signed `host-data` socket that runs the
// responder E2EE handshake and feeds decrypted frames into a tunnel-host
// dispatcher. Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 1).

import { WebSocket } from 'ws';

import { RELAY_PROTOCOL_VERSION } from './e2ee.js';
import { createEncryptedSession } from './encrypted-session.js';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const DATA_SOCKET_OPEN_TIMEOUT_MS = 15000;
// Clients send a tunnel Ping at least every ~30s when idle, so a data socket
// with no inbound traffic for 3 ping intervals belongs to a client that died
// without a WebSocket close (network loss, battery kill). The relay worker may
// not notice the dead client leg for a long time, so the host must reap these
// itself — both to free resources and to keep the "N devices connected" status
// honest instead of counting ghosts.
const DATA_SOCKET_IDLE_TIMEOUT_MS = 90_000;
const DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS = 30_000;
// Protocol-level keepalive for the control socket. Without it, a network path
// that dies silently (NAT timeout, relay-edge eviction without close frames)
// leaves the host believing it is registered while the relay has forgotten it —
// every client tunnel then hangs in `connecting` forever. A missed pong window
// terminates the socket, which drives the normal reconnect + re-registration.
const CONTROL_PING_INTERVAL_MS = 30_000;
const CONTROL_PONG_GRACE_MS = 10_000;
const DEFAULT_BATCH_WINDOW_MS = 150;

// Resolve the frame-batching flush window: explicit option wins, then env, then
// the 150 ms default. Only applies on directions where batching was negotiated.
const resolveBatchWindowMs = (option) => {
  if (Number.isFinite(option) && option >= 0) return option;
  const envValue = Number.parseInt(process.env.OPENCHAMBER_RELAY_BATCH_WINDOW_MS ?? '', 10);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return DEFAULT_BATCH_WINDOW_MS;
};

/**
 * @param {{
 *   relayUrl: string,
 *   identity: { serverId: string, hostEncPrivateKey: CryptoKey, signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string } },
 *   localPort?: number,
 *   getLocalPort?: () => number,
 *   onStatus?: (status: { state: string, lastError: string | null, connectedClients: number }) => void,
 *   logger?: Pick<Console, 'warn'>,
 * }} options
 */
export const startRelayHost = ({ relayUrl, identity, localPort, getLocalPort, onStatus, logger = console, batchWindowMs, batch }) => {
  const resolveLocalPort = typeof getLocalPort === 'function' ? getLocalPort : () => localPort;
  const localBatch = batch !== false;
  const resolvedBatchWindowMs = resolveBatchWindowMs(batchWindowMs);

  let stopped = false;
  let state = 'connecting';
  let lastError = null;
  let controlSocket = null;
  let reconnectTimer = null;
  let consecutiveFailures = 0;
  /** @type {Map<string, { socket: WebSocket, session: ReturnType<typeof createEncryptedSession> | null, openTimer: NodeJS.Timeout | null, lastActivityAt: number }>} */
  const dataSockets = new Map();

  const emitStatus = () => {
    try {
      onStatus?.({ state, lastError, connectedClients: dataSockets.size });
    } catch {
      // status consumers must not break the transport
    }
  };

  const setState = (nextState, error) => {
    state = nextState;
    if (error !== undefined) lastError = error;
    emitStatus();
  };

  const buildSocketUrl = (role, connectionId) => {
    const url = new URL(relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', role);
    url.searchParams.set('serverId', identity.serverId);
    if (connectionId) url.searchParams.set('connectionId', connectionId);
    const auth = identity.signRelayAuth(role, connectionId ?? null);
    url.searchParams.set('ts', String(auth.ts));
    url.searchParams.set('sig', auth.sig);
    url.searchParams.set('pk', auth.pk);
    return url.toString();
  };

  const teardownDataSocket = (connectionId, closeCode, reason) => {
    const entry = dataSockets.get(connectionId);
    if (!entry) return;
    dataSockets.delete(connectionId);
    if (entry.openTimer) clearTimeout(entry.openTimer);
    entry.session?.close();
    try {
      if (entry.socket.readyState === WebSocket.OPEN || entry.socket.readyState === WebSocket.CONNECTING) {
        if (closeCode) entry.socket.close(closeCode, reason ?? '');
        else entry.socket.terminate();
      }
    } catch {
      // socket already gone
    }
    emitStatus();
  };

  const openDataSocket = (connectionId) => {
    if (stopped || dataSockets.has(connectionId)) return;

    let socket;
    try {
      socket = new WebSocket(buildSocketUrl('host-data', connectionId));
    } catch (error) {
      logger.warn(`[Relay] host-data dial failed: ${error?.message ?? error}`);
      return;
    }

    const entry = { socket, session: null, openTimer: null, lastActivityAt: Date.now() };
    dataSockets.set(connectionId, entry);
    entry.openTimer = setTimeout(() => {
      logger.warn('[Relay] host-data socket open timeout');
      teardownDataSocket(connectionId);
    }, DATA_SOCKET_OPEN_TIMEOUT_MS);

    const failChannel = (closeCode, reason) => {
      // connectionId + reason only — never payload contents.
      logger.warn(`[Relay] data channel failed connectionId=${connectionId} reason=${reason ?? 'unknown'}`);
      teardownDataSocket(connectionId, closeCode, reason);
    };

    entry.session = createEncryptedSession({
      socket,
      connectionId,
      hostEncPrivateKey: identity.hostEncPrivateKey,
      getLocalPort: resolveLocalPort,
      isActive: () => dataSockets.get(connectionId) === entry,
      onActivity: () => { entry.lastActivityAt = Date.now(); },
      onFailure: failChannel,
      logger,
      batch: localBatch,
      batchWindowMs: resolvedBatchWindowMs,
    });

    socket.on('open', () => {
      if (entry.openTimer) {
        clearTimeout(entry.openTimer);
        entry.openTimer = null;
      }
      emitStatus();
    });
    socket.on('message', (data, isBinary) => {
      entry.session?.receive(data, isBinary);
    });
    socket.on('close', () => {
      teardownDataSocket(connectionId);
    });
    socket.on('error', (error) => {
      logger.warn(`[Relay] host-data socket error: ${error?.message ?? error}`);
    });
  };

  const handleControlMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'sync' && Array.isArray(message.connectionIds)) {
      const wanted = new Set(message.connectionIds.filter((id) => typeof id === 'string' && id.length > 0));
      for (const connectionId of [...dataSockets.keys()]) {
        if (!wanted.has(connectionId)) teardownDataSocket(connectionId);
      }
      for (const connectionId of wanted) {
        openDataSocket(connectionId);
      }
      return;
    }
    if (message.type === 'connected' && typeof message.connectionId === 'string') {
      openDataSocket(message.connectionId);
      return;
    }
    if (message.type === 'disconnected' && typeof message.connectionId === 'string') {
      teardownDataSocket(message.connectionId);
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** consecutiveFailures, BACKOFF_CAP_MS);
    consecutiveFailures += 1;
    setState('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl();
    }, delay);
  };

  const connectControl = () => {
    if (stopped) return;
    setState(consecutiveFailures === 0 ? 'connecting' : 'reconnecting');

    let socket;
    try {
      socket = new WebSocket(buildSocketUrl('host-control'));
    } catch (error) {
      lastError = error?.message ?? String(error);
      scheduleReconnect();
      return;
    }
    controlSocket = socket;

    // Liveness: ping on an interval; any pong (or message) proves the path.
    // A quiet window beyond interval+grace means the connection silently died —
    // terminate so the close handler reconnects and re-registers at the relay.
    let lastAliveAt = Date.now();
    const pingTimer = setInterval(() => {
      if (controlSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAliveAt > CONTROL_PING_INTERVAL_MS + CONTROL_PONG_GRACE_MS) {
        logger.warn('[Relay] control socket unresponsive (missed pong) — reconnecting');
        try {
          socket.terminate();
        } catch {
          // terminate is best-effort; the close handler still runs.
        }
        return;
      }
      try {
        socket.ping();
      } catch {
        // Send failure surfaces via the error/close handlers.
      }
    }, CONTROL_PING_INTERVAL_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();

    socket.on('open', () => {
      if (controlSocket !== socket) return;
      consecutiveFailures = 0;
      lastAliveAt = Date.now();
      setState('connected', null);
    });
    socket.on('pong', () => {
      lastAliveAt = Date.now();
    });
    socket.on('message', (data, isBinary) => {
      if (controlSocket !== socket || isBinary) return;
      lastAliveAt = Date.now();
      handleControlMessage(data.toString('utf8'));
    });
    socket.on('error', (error) => {
      if (controlSocket !== socket) return;
      lastError = error?.message ?? String(error);
    });
    socket.on('close', (code, reasonBuffer) => {
      clearInterval(pingTimer);
      if (controlSocket !== socket) return;
      controlSocket = null;
      const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
      if (!lastError && code && code !== 1000) {
        lastError = `control socket closed (${code}${reason ? `: ${reason}` : ''})`;
      }
      // Data sockets ride their own relay connections; the relay keeps clients
      // alive through a 30 s control-reconnect grace window, so leave them up.
      scheduleReconnect();
    });
  };

  // Reap data sockets whose client went silent (no frames, no keepalive pings)
  // — a dead phone leg the relay worker hasn't noticed yet.
  const idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [connectionId, entry] of [...dataSockets.entries()]) {
      if (now - entry.lastActivityAt <= DATA_SOCKET_IDLE_TIMEOUT_MS) continue;
      logger.info(`[Relay] reaping idle data socket connectionId=${connectionId}`);
      teardownDataSocket(connectionId, 1001, 'client idle timeout');
    }
  }, DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS);
  if (typeof idleSweepTimer.unref === 'function') idleSweepTimer.unref();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(idleSweepTimer);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const connectionId of [...dataSockets.keys()]) {
      teardownDataSocket(connectionId, 1001, 'host stopping');
    }
    const socket = controlSocket;
    controlSocket = null;
    if (socket) {
      try {
        socket.close(1001, 'host stopping');
      } catch {
        socket.terminate();
      }
    }
    setState('disabled');
  };

  connectControl();

  return {
    stop,
    getStatus: () => ({ state, lastError, connectedClients: dataSockets.size }),
  };
};
