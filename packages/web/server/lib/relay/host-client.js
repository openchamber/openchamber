// Long-lived relay host client: maintains the signed `host-control` socket to
// the relay, and per connected client a signed `host-data` socket that runs the
// responder E2EE handshake and feeds decrypted frames into a tunnel-host
// dispatcher. Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 1).

import { WebSocket } from 'ws';

import { RELAY_PROTOCOL_VERSION, RelayCloseCode, createHostHandshake } from './e2ee.js';
import { createOutboundFrameBatcher, decodeFrameBatch } from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const DATA_SOCKET_OPEN_TIMEOUT_MS = 15000;
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
  /** @type {Map<string, { socket: WebSocket, tunnel: ReturnType<typeof createTunnelHost> | null, openTimer: NodeJS.Timeout | null }>} */
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
    entry.batcher?.dispose();
    entry.tunnel?.close();
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

    const entry = { socket, tunnel: null, openTimer: null, batcher: null };
    dataSockets.set(connectionId, entry);
    entry.openTimer = setTimeout(() => {
      logger.warn('[Relay] host-data socket open timeout');
      teardownDataSocket(connectionId);
    }, DATA_SOCKET_OPEN_TIMEOUT_MS);

    const handshake = createHostHandshake(identity.hostEncPrivateKey, { batch: localBatch });
    let channel = null;
    let batchNegotiated = false;
    // Serialize async message handling so encrypted frame order (and the
    // strictly-increasing decrypt counter) is preserved.
    let processing = Promise.resolve();
    // Serialize encrypt+send so the per-direction IV counter reaches the wire in
    // encryption order. One encrypt() == one WS message == one counter tick,
    // whether it carries a batch or a lone frame.
    let sendChain = Promise.resolve();
    const sendEncryptedPlaintext = (plaintext) => {
      sendChain = sendChain
        .then(async () => {
          if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN || !channel) return;
          const encrypted = await channel.encryptor.encrypt(plaintext);
          socket.send(encrypted, { binary: true });
        })
        .catch((error) => {
          logger.warn(`[Relay] host-data send failed: ${error?.message ?? error}`);
        });
    };

    const failChannel = (closeCode, reason) => {
      // connectionId + reason only — never payload contents.
      logger.warn(`[Relay] data channel failed connectionId=${connectionId} reason=${reason ?? 'unknown'}`);
      teardownDataSocket(connectionId, closeCode, reason);
    };

    const handleMessage = async (data, isBinary) => {
      const current = dataSockets.get(connectionId);
      if (current !== entry) return;

      if (!isBinary) {
        const action = await handshake.handleText(data.toString('utf8'));
        if (action.type === 'send-text') {
          socket.send(action.text);
        } else if (action.type === 'established') {
          channel = action.channel;
          batchNegotiated = action.batch === true;
          entry.batcher = batchNegotiated
            ? createOutboundFrameBatcher({ windowMs: resolvedBatchWindowMs, sendBatch: sendEncryptedPlaintext })
            : null;
          entry.tunnel = createTunnelHost({
            connectionId,
            getLocalPort: resolveLocalPort,
            getBufferedAmount: () => socket.bufferedAmount,
            sendFrame: (plaintextFrame) => {
              if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN) return;
              if (entry.batcher) entry.batcher.enqueue(plaintextFrame);
              else sendEncryptedPlaintext(plaintextFrame);
            },
          });
          if (action.replyText) socket.send(action.replyText);
        } else if (action.type === 'fail') {
          failChannel(action.closeCode, action.reason);
        }
        return;
      }

      if (!channel || !entry.tunnel) {
        // Encrypted traffic before the handshake completed: fail closed.
        failChannel(RelayCloseCode.ChannelFailure, 'binary frame before handshake');
        return;
      }
      let plaintext;
      try {
        plaintext = await channel.decryptor.decrypt(new Uint8Array(data));
      } catch {
        failChannel(RelayCloseCode.ChannelFailure, 'frame decryption failed');
        return;
      }
      try {
        if (batchNegotiated) {
          // One encrypted message may carry several tunnel frames; dispatch each
          // in order through the same per-frame handling as legacy.
          for (const frame of decodeFrameBatch(plaintext)) {
            if (dataSockets.get(connectionId) !== entry) return;
            await entry.tunnel.handleFrame(frame);
          }
        } else {
          await entry.tunnel.handleFrame(plaintext);
        }
      } catch (error) {
        logger.warn(`[Relay] tunnel frame handling failed: ${error?.message ?? error}`);
      }
    };

    socket.on('open', () => {
      if (entry.openTimer) {
        clearTimeout(entry.openTimer);
        entry.openTimer = null;
      }
      emitStatus();
    });
    socket.on('message', (data, isBinary) => {
      processing = processing
        .then(() => handleMessage(data, isBinary))
        .catch((error) => {
          logger.warn(`[Relay] data socket message failed: ${error?.message ?? error}`);
          failChannel(RelayCloseCode.ChannelFailure, 'internal error');
        });
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

    socket.on('open', () => {
      if (controlSocket !== socket) return;
      consecutiveFailures = 0;
      setState('connected', null);
    });
    socket.on('message', (data, isBinary) => {
      if (controlSocket !== socket || isBinary) return;
      handleControlMessage(data.toString('utf8'));
    });
    socket.on('error', (error) => {
      if (controlSocket !== socket) return;
      lastError = error?.message ?? String(error);
    });
    socket.on('close', (code, reasonBuffer) => {
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

  const stop = () => {
    if (stopped) return;
    stopped = true;
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
