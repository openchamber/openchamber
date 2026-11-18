
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';
import { webPackagePaths } from '../web-package-paths.js';

import { RELAY_PROTOCOL_VERSION, RelayCloseCode, createHostHandshake } from './e2ee.js';
import { createOutboundFrameBatcher, decodeFrameBatch, decodeTunnelFrame, decodeDeliveryAck, encodeFrameBatch, TunnelFrameType } from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';
import { createDownstreamScheduler, DOWNSTREAM_CHUNK_BYTES } from './downstream-scheduler.js';
import { redactSensitiveText } from '../source-control/url-redaction.js';
import { z } from 'zod';

const shareStateMessageSchema = z.object({ type: z.literal('share-state'), shareId: z.string().min(1) });

const relayRetireSchema = z.object({ type: z.literal('relay-retire'), code: z.number().int(), reason: z.string().catch('') });
const parseRelayRetire = (raw) => {
  try {
    const parsed = relayRetireSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const CONTROL_REPLACED_RECONNECT_MS = 60_000;
const IDENTITY_CONFLICT_WINDOW_MS = 10 * 60_000;
const DATA_SOCKET_FIRST_OPEN_TIMEOUT_MS = 5000;
const DATA_SOCKET_OPEN_TIMEOUT_MS = 15000;
const DATA_SOCKET_REDIAL_BASE_MS = 1000;
const DATA_SOCKET_REDIAL_CAP_MS = 8000;
const DATA_SOCKET_IDLE_TIMEOUT_MS = 90_000;
const DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS = 30_000;
const CONTROL_PING_INTERVAL_MS = 30_000;
const CONTROL_PONG_GRACE_MS = 10_000;
// external: https://github.com/oven-sh/bun/blob/bun-v1.3.0/src/js/thirdparty/ws.js Bun's ws shim ignores handshakeTimeout, so the host times control socket opens itself.
const CONTROL_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_WINDOW_MS = 150;

const resolveBatchWindowMs = (option) => {
  if (Number.isFinite(option) && option >= 0) return option;
  const envValue = Number.parseInt(process.env.OPENCHAMBER_RELAY_BATCH_WINDOW_MS ?? '', 10);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return DEFAULT_BATCH_WINDOW_MS;
};

// external: https://github.com/oven-sh/bun/blob/bun-v1.3.0/src/js/thirdparty/ws.js Bun WebSocket errors include the signed dial URL, so relay errors require redaction before logging or status reporting.
export const describeRelayError = (error) => redactSensitiveText(error?.message ?? error);

/**
 * @param {{
 *   relayUrl: string,
 *   identity: { serverId: string, hostEncPrivateKey: CryptoKey, signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string } },
 *   localPort?: number,
 *   getLocalPort?: () => number,
 *   onStatus?: (status: { state: string, lastError: string | null, connectedClients: number, identityConflict: boolean }) => void,
 *   logger?: Pick<Console, 'warn'>,
 *   createSocket?: (url: string) => WebSocket,
 * }} options
 */
export const startRelayHost = ({ relayUrl, identity, localPort, getLocalPort, onStatus, onShareState, logger = console, createSocket = (url) => new WebSocket(url), batchWindowMs, batch, flowControl }) => {
  const { version } = createRequire(import.meta.url)(webPackagePaths.packageJson);
  const platform = process.env.OPENCHAMBER_RUNTIME || 'web';
  const resolveLocalPort = typeof getLocalPort === 'function' ? getLocalPort : () => localPort;
  const localBatch = batch !== false;
  const resolvedBatchWindowMs = resolveBatchWindowMs(batchWindowMs);

  let stopped = false;
  let state = 'connecting';
  let lastError = null;
  /** @type {number[]} */
  let controlReplacedAt = [];
  let controlSocket = null;
  let reconnectTimer = null;
  let consecutiveFailures = 0;
  /** @type {Map<string, { socket: WebSocket, tunnel: ReturnType<typeof createTunnelHost> | null, openTimer: NodeJS.Timeout | null }>} */
  const dataSockets = new Map();
  /** @type {Map<string, { failedDials: number, redialTimer: NodeJS.Timeout | null }>} */
  const announcedClients = new Map();

  const hasIdentityConflict = () => {
    const now = Date.now();
    controlReplacedAt = controlReplacedAt.filter((at) => now - at < IDENTITY_CONFLICT_WINDOW_MS);
    return controlReplacedAt.length >= 2;
  };

  const currentStatus = () => ({ state, lastError, connectedClients: dataSockets.size, identityConflict: hasIdentityConflict() });

  const emitStatus = () => {
    try {
      onStatus?.(currentStatus());
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
    url.searchParams.set('appId', 'openchamber');
    url.searchParams.set('appVersion', version);
    url.searchParams.set('platform', platform);
    if (connectionId) url.searchParams.set('connectionId', connectionId);
    const auth = identity.signRelayAuth(role, connectionId ?? null);
    url.searchParams.set('ts', String(auth.ts));
    url.searchParams.set('sig', auth.sig);
    url.searchParams.set('pk', auth.pk);
    return url.toString();
  };

  const announceClient = (connectionId) => {
    if (!announcedClients.has(connectionId)) announcedClients.set(connectionId, { failedDials: 0, redialTimer: null });
  };

  const forgetClient = (connectionId) => {
    const client = announcedClients.get(connectionId);
    if (client?.redialTimer) clearTimeout(client.redialTimer);
    announcedClients.delete(connectionId);
  };

  const cancelRedials = () => {
    for (const client of announcedClients.values()) {
      if (client.redialTimer) clearTimeout(client.redialTimer);
      client.redialTimer = null;
    }
  };

  const scheduleRedial = (connectionId) => {
    const client = announcedClients.get(connectionId);
    if (stopped || !client || client.redialTimer || controlSocket?.readyState !== WebSocket.OPEN) return;
    const delay = Math.min(DATA_SOCKET_REDIAL_BASE_MS * 2 ** client.failedDials, DATA_SOCKET_REDIAL_CAP_MS);
    client.failedDials += 1;
    client.redialTimer = setTimeout(() => {
      client.redialTimer = null;
      openDataSocket(connectionId);
    }, delay);
  };

  const teardownDataSocket = (connectionId, closeCode, reason) => {
    const entry = dataSockets.get(connectionId);
    if (!entry) return;
    dataSockets.delete(connectionId);
    if (!entry.opened) scheduleRedial(connectionId);
    if (entry.openTimer) clearTimeout(entry.openTimer);
    entry.batcher?.dispose();
    entry.scheduler?.close();
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
    const client = announcedClients.get(connectionId);
    if (client?.redialTimer) {
      clearTimeout(client.redialTimer);
      client.redialTimer = null;
    }

    let socket;
    try {
      socket = createSocket(buildSocketUrl('host-data', connectionId));
    } catch (error) {
      logger.warn(`[Relay] host-data dial failed: ${describeRelayError(error)}`);
      scheduleRedial(connectionId);
      return;
    }

    const entry = { socket, opened: false, tunnel: null, openTimer: null, batcher: null, scheduler: null, lastActivityAt: Date.now() };
    dataSockets.set(connectionId, entry);
    const openTimeoutMs = Math.min(DATA_SOCKET_FIRST_OPEN_TIMEOUT_MS * 2 ** (client?.failedDials ?? 0), DATA_SOCKET_OPEN_TIMEOUT_MS);
    entry.openTimer = setTimeout(() => {
      logger.warn('[Relay] host-data socket open timeout');
      teardownDataSocket(connectionId);
    }, openTimeoutMs);

    const handshake = createHostHandshake(identity.hostEncPrivateKey, { batch: localBatch, flowControl });
    let channel = null;
    let batchNegotiated = false;
    let processing = Promise.resolve();
    let sendChain = Promise.resolve();
    const sendEncryptedPlaintext = (plaintext) => {
      sendChain = sendChain
        .then(async () => {
          if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN || !channel) return;
          const encrypted = await channel.encryptor.encrypt(plaintext);
          if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN) return;
          socket.send(encrypted, { binary: true });
        })
        .catch((error) => {
          logger.warn(`[Relay] host-data send failed: ${describeRelayError(error)}`);
          failChannel(RelayCloseCode.ChannelFailure, 'send failed');
        });
      return sendChain;
    };

    const failChannel = (closeCode, reason) => {
      logger.warn(`[Relay] data channel failed connectionId=${connectionId} reason=${reason ?? 'unknown'}`);
      teardownDataSocket(connectionId, closeCode, reason);
    };

    const handleMessage = async (data, isBinary) => {
      const retire = isBinary ? null : parseRelayRetire(data.toString('utf8'));
      if (retire) {
        if (dataSockets.get(connectionId) === entry) teardownDataSocket(connectionId, 1000, retire.reason);
        else socket.close(1000);
        return;
      }
      const current = dataSockets.get(connectionId);
      if (current !== entry) return;
      entry.lastActivityAt = Date.now();

      if (!isBinary) {
        const action = await handshake.handleText(data.toString('utf8'));
        if (action.type === 'send-text') {
          socket.send(action.text);
        } else if (action.type === 'established') {
          channel = action.channel;
          batchNegotiated = action.batch === true;
          entry.scheduler = action.flowControl ? createDownstreamScheduler({
            sendBatch: frames => sendEncryptedPlaintext(batchNegotiated ? encodeFrameBatch(frames) : frames[0]),
            maxBatchFrames: batchNegotiated ? 32 : 1,
            onError: () => failChannel(RelayCloseCode.ChannelFailure, 'downstream queue failed'),
          }) : null;
          entry.batcher = batchNegotiated && !entry.scheduler
            ? createOutboundFrameBatcher({ windowMs: resolvedBatchWindowMs, sendBatch: sendEncryptedPlaintext })
            : null;
          entry.tunnel = createTunnelHost({
            connectionId,
            getLocalPort: resolveLocalPort,
            getBufferedAmount: () => socket.bufferedAmount,
            responseChunkBytes: entry.scheduler ? DOWNSTREAM_CHUNK_BYTES : undefined,
            cancelPendingFrames: streamId => entry.scheduler?.cancel(streamId),
            sendFrame: (plaintextFrame) => {
              if (dataSockets.get(connectionId) !== entry || socket.readyState !== WebSocket.OPEN) return;
              if (entry.scheduler) return entry.scheduler.send(plaintextFrame);
              if (entry.batcher) entry.batcher.enqueue(plaintextFrame);
              else return sendEncryptedPlaintext(plaintextFrame);
            },
          });
          if (action.replyText) socket.send(action.replyText);
        } else if (action.type === 'fail') {
          failChannel(action.closeCode, action.reason);
        }
        return;
      }

      if (!channel || !entry.tunnel) {
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
          for (const frame of decodeFrameBatch(plaintext)) {
            if (dataSockets.get(connectionId) !== entry) return;
            await dispatchFrame(frame);
          }
        } else {
          await dispatchFrame(plaintext);
        }
      } catch (error) {
        logger.warn(`[Relay] tunnel frame handling failed: ${describeRelayError(error)}`);
        failChannel(RelayCloseCode.ChannelFailure, 'invalid tunnel frame');
      }
    };

    const dispatchFrame = (plaintext) => {
      const frame = decodeTunnelFrame(plaintext);
      if (frame.frameType === TunnelFrameType.DeliveryAck) {
        if (!entry.scheduler || frame.streamId !== 0 || frame.hasMoreFragments) {
          throw new Error('unexpected delivery acknowledgement');
        }
        entry.scheduler.acknowledge(decodeDeliveryAck(frame.payload));
        return;
      }
      void entry.tunnel.handleFrame(plaintext).catch(() => {
        failChannel(RelayCloseCode.ChannelFailure, 'invalid tunnel frame');
      });
    };

    const dialedAt = Date.now();
    socket.on('open', () => {
      if (entry.openTimer) {
        clearTimeout(entry.openTimer);
        entry.openTimer = null;
      }
      entry.opened = true;
      const current = announcedClients.get(connectionId);
      if (current) current.failedDials = 0;
      emitStatus();
    });
    socket.on('message', (data, isBinary) => {
      processing = processing
        .then(() => handleMessage(data, isBinary))
        .catch((error) => {
          logger.warn(`[Relay] data socket message failed: ${describeRelayError(error)}`);
          failChannel(RelayCloseCode.ChannelFailure, 'internal error');
        });
    });
    socket.on('close', (code, reason) => {
      logger.info?.(`[Relay] data socket closed connectionId=${connectionId} code=${code}${reason?.length ? ` reason=${reason.toString('utf8')}` : ''} after=${Math.round((Date.now() - dialedAt) / 1000)}s`);
      if (dataSockets.get(connectionId) === entry) teardownDataSocket(connectionId);
    });
    socket.on('error', (error) => {
      logger.warn(`[Relay] host-data socket error: ${describeRelayError(error)}`);
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
      for (const connectionId of [...announcedClients.keys()]) {
        if (!wanted.has(connectionId)) forgetClient(connectionId);
      }
      for (const connectionId of [...dataSockets.keys()]) {
        if (!wanted.has(connectionId)) teardownDataSocket(connectionId);
      }
      for (const connectionId of wanted) {
        announceClient(connectionId);
        openDataSocket(connectionId);
      }
      return;
    }
    if (message.type === 'connected' && typeof message.connectionId === 'string') {
      announceClient(message.connectionId);
      openDataSocket(message.connectionId);
      return;
    }
    if (message.type === 'disconnected' && typeof message.connectionId === 'string') {
      forgetClient(message.connectionId);
      teardownDataSocket(message.connectionId);
      return;
    }
    const shareState = shareStateMessageSchema.safeParse(message);
    if (shareState.success) {
      try {
        onShareState?.(shareState.data.shareId);
      } catch (error) {
        logger.warn?.(`[Relay] share-state listener failed: ${describeRelayError(error)}`);
      }
    }
  };

  const scheduleReconnect = (minDelayMs = 0) => {
    if (stopped || reconnectTimer) return;
    const delay = Math.max(minDelayMs, Math.min(BACKOFF_BASE_MS * 2 ** consecutiveFailures, BACKOFF_CAP_MS));
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
      socket = createSocket(buildSocketUrl('host-control'));
    } catch (error) {
      lastError = describeRelayError(error);
      scheduleReconnect();
      return;
    }
    controlSocket = socket;
    const dialedAt = Date.now();
    let retiredWith = null;
    let openTimedOut = false;
    const openTimer = setTimeout(() => {
      if (controlSocket !== socket) return;
      openTimedOut = true;
      lastError = 'control socket open timeout';
      logger.warn('[Relay] control socket open timeout');
      socket.terminate();
    }, CONTROL_OPEN_TIMEOUT_MS);

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
      clearTimeout(openTimer);
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
      const raw = data.toString('utf8');
      const retire = parseRelayRetire(raw);
      if (retire) {
        retiredWith = retire;
        socket.close(1000);
        return;
      }
      handleControlMessage(raw);
    });
    socket.on('error', (error) => {
      if (controlSocket !== socket || openTimedOut) return;
      lastError = describeRelayError(error);
    });
    socket.on('close', (closeCode, reasonBuffer) => {
      clearTimeout(openTimer);
      clearInterval(pingTimer);
      if (controlSocket !== socket) return;
      controlSocket = null;
      const code = retiredWith ? retiredWith.code : closeCode;
      const reason = retiredWith ? retiredWith.reason : reasonBuffer ? reasonBuffer.toString('utf8') : '';
      logger.info?.(`[Relay] control socket closed code=${code}${reason ? ` reason=${reason}` : ''} after=${Math.round((Date.now() - dialedAt) / 1000)}s`);
      if (!lastError && code && code !== 1000) {
        lastError = `control socket closed (${code}${reason ? `: ${reason}` : ''})`;
      }
      cancelRedials();
      const replaced = code === RelayCloseCode.ControlReplaced;
      if (replaced) controlReplacedAt.push(Date.now());
      scheduleReconnect(replaced ? CONTROL_REPLACED_RECONNECT_MS : 0);
    });
  };

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
    cancelRedials();
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
    getStatus: currentStatus,
  };
};
