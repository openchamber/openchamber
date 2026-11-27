
import { WebSocket, type ClientOptions } from 'ws';
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import { createRequire } from 'node:module';
import { webPackagePaths } from '../web-package-paths.js';
import { resolveOutboundProxyEnv } from '../outbound-proxy.js';

import { RELAY_PROTOCOL_VERSION, RelayCloseCode, createHostHandshake } from './e2ee.js';
import { createOutboundFrameBatcher, decodeFrameBatch, decodeTunnelFrame, decodeDeliveryAck, encodeFrameBatch, TunnelFrameType } from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';
import { createDownstreamScheduler, DOWNSTREAM_CHUNK_BYTES } from './downstream-scheduler.js';
import { redactSensitiveText } from '../source-control/url-redaction.js';
import { z } from 'zod';
import type { WebSocket as RelayWebSocket } from '../shared/websocket-contracts.js';
import type { RelayChannel } from './e2ee.js';
import type { RelayIdentity } from './identity.js';

export interface RelayHostStatus {
  state: string;
  lastError: string | null;
  connectedClients: number;
  identityConflict: boolean;
}

export interface RelayHostOptions {
  relayUrl: string;
  identity: Pick<RelayIdentity, 'serverId' | 'hostEncPrivateKey' | 'signRelayAuth'>;
  localPort?: number;
  getLocalPort?: () => number;
  onStatus?: (status: RelayHostStatus) => void;
  onShareState?: (shareId: string) => void;
  logger?: Pick<Console, 'warn'> & Partial<Pick<Console, 'info'>>;
  createSocket?: (url: string) => RelayWebSocket<Buffer>;
  batchWindowMs?: number;
  batch?: boolean;
  flowControl?: boolean;
}

interface DataSocket {
  socket: RelayWebSocket<Buffer>;
  opened: boolean;
  tunnel: ReturnType<typeof createTunnelHost> | null;
  openTimer: NodeJS.Timeout | null;
  batcher: ReturnType<typeof createOutboundFrameBatcher> | null;
  scheduler: ReturnType<typeof createDownstreamScheduler<ArrayBuffer>> | null;
  lastActivityAt: number;
}

interface AnnouncedClient { failedDials: number; redialTimer: NodeJS.Timeout | null }

const hasErrorMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;
const isControlMessage = (value: unknown): value is { type?: unknown; connectionIds?: unknown; connectionId?: unknown } =>
  Boolean(value && typeof value === 'object');
const isConnectionId = (value: unknown): value is string => typeof value === 'string';
const isNonemptyConnectionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const shareStateMessageSchema = z.object({ type: z.literal('share-state'), shareId: z.string().min(1) });

const relayRetireSchema = z.object({ type: z.literal('relay-retire'), code: z.number().int(), reason: z.string().catch('') });
const parseRelayRetire = (raw: string) => {
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
const CONTROL_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_WINDOW_MS = 150;

const resolveBatchWindowMs = (option: number | undefined) => {
  if (option !== undefined && Number.isFinite(option) && option >= 0) return option;
  const envValue = Number.parseInt(process.env.OPENCHAMBER_RELAY_BATCH_WINDOW_MS ?? '', 10);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return DEFAULT_BATCH_WINDOW_MS;
};

export const describeRelayError = (cause: unknown) => redactSensitiveText(String(((hasErrorMessage(cause) ? cause.message : undefined) ?? cause) || ''));

const ipv4ToInt = (ip: string) => ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);

export const relayDialBypassesProxy = (url: string, noProxy: string) => {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'))) return true;
  const hostWithPort = `${host}:${parsed.port || (parsed.protocol === 'wss:' ? '443' : '80')}`;
  return noProxy.split(',').some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '*' || entry === host || entry === hostWithPort) return true;
    if (entry.startsWith('.') && (host === entry.slice(1) || host.endsWith(entry))) return true;
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true;
    if (!entry.includes('-') || !isIPv4(host)) return false;
    const [start = '', end = ''] = entry.split('-').map((part) => part.trim());
    return isIPv4(start) && isIPv4(end) && ipv4ToInt(host) >= ipv4ToInt(start) && ipv4ToInt(host) <= ipv4ToInt(end);
  });
};

const defaultRelaySocket = (url: string) => {
  const proxyEnv = resolveOutboundProxyEnv(process.env);
  const secure = url.startsWith('wss:');
  const proxyUrl = secure ? proxyEnv?.HTTPS_PROXY : proxyEnv?.HTTP_PROXY;
  if (!proxyEnv || !proxyUrl || relayDialBypassesProxy(url, proxyEnv.NO_PROXY)) return new WebSocket(url);
  if (process.versions.bun) {
    const options: ClientOptions & { proxy: string } = { proxy: proxyUrl };
    return new WebSocket(url, options);
  }
  return new WebSocket(url, { agent: secure ? https.globalAgent : http.globalAgent });
};

export const startRelayHost = ({ relayUrl, identity, localPort, getLocalPort, onStatus, onShareState, logger = console, createSocket = defaultRelaySocket, batchWindowMs, batch, flowControl }: RelayHostOptions) => {
  const { version }: { version?: unknown } = createRequire(import.meta.url)(webPackagePaths.packageJson);
  const platform = process.env.OPENCHAMBER_RUNTIME || 'web';
  const resolveLocalPort = getLocalPort ?? (() => localPort);
  const localBatch = batch !== false;
  const resolvedBatchWindowMs = resolveBatchWindowMs(batchWindowMs);

  let stopped = false;
  let state = 'connecting';
  let lastError: string | null = null;
  let controlReplacedAt: number[] = [];
  let controlSocket: RelayWebSocket<Buffer> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let consecutiveFailures = 0;
  const dataSockets = new Map<string, DataSocket>();
  const announcedClients = new Map<string, AnnouncedClient>();

  const hasIdentityConflict = () => {
    const now = Date.now();
    controlReplacedAt = controlReplacedAt.filter((at) => now - at < IDENTITY_CONFLICT_WINDOW_MS);
    return controlReplacedAt.length >= 2;
  };

  const currentStatus = (): RelayHostStatus => ({ state, lastError, connectedClients: dataSockets.size, identityConflict: hasIdentityConflict() });

  const emitStatus = () => {
    try {
      onStatus?.(currentStatus());
    } catch (error) {
      void error;
    }
  };

  const setState = (nextState: string, error?: string | null) => {
    state = nextState;
    if (error !== undefined) lastError = error;
    emitStatus();
  };

  const buildSocketUrl = (role: string, connectionId?: string) => {
    const url = new URL(relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', role);
    url.searchParams.set('serverId', identity.serverId);
    url.searchParams.set('appId', 'openchamber');
    url.searchParams.set('appVersion', String(version));
    url.searchParams.set('platform', platform);
    if (connectionId) url.searchParams.set('connectionId', connectionId);
    const auth = identity.signRelayAuth(role, connectionId ?? null);
    url.searchParams.set('ts', String(auth.ts));
    url.searchParams.set('sig', auth.sig);
    url.searchParams.set('pk', auth.pk);
    return url.toString();
  };

  const announceClient = (connectionId: string) => {
    if (!announcedClients.has(connectionId)) announcedClients.set(connectionId, { failedDials: 0, redialTimer: null });
  };

  const forgetClient = (connectionId: string) => {
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

  const scheduleRedial = (connectionId: string) => {
    const client = announcedClients.get(connectionId);
    if (stopped || !client || client.redialTimer || controlSocket?.readyState !== WebSocket.OPEN) return;
    const delay = Math.min(DATA_SOCKET_REDIAL_BASE_MS * 2 ** client.failedDials, DATA_SOCKET_REDIAL_CAP_MS);
    client.failedDials += 1;
    client.redialTimer = setTimeout(() => {
      client.redialTimer = null;
      openDataSocket(connectionId);
    }, delay);
  };

  const teardownDataSocket = (connectionId: string, closeCode?: number, reason?: string) => {
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
    } catch (error) {
      void error;
    }
    emitStatus();
  };

  const openDataSocket = (connectionId: string) => {
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

    const entry: DataSocket = { socket, opened: false, tunnel: null, openTimer: null, batcher: null, scheduler: null, lastActivityAt: Date.now() };
    dataSockets.set(connectionId, entry);
    const openTimeoutMs = Math.min(DATA_SOCKET_FIRST_OPEN_TIMEOUT_MS * 2 ** (client?.failedDials ?? 0), DATA_SOCKET_OPEN_TIMEOUT_MS);
    entry.openTimer = setTimeout(() => {
      logger.warn('[Relay] host-data socket open timeout');
      teardownDataSocket(connectionId);
    }, openTimeoutMs);

    const handshake = createHostHandshake(identity.hostEncPrivateKey, { batch: localBatch, flowControl });
    let channel: RelayChannel | null = null;
    let batchNegotiated = false;
    let processing = Promise.resolve();
    let sendChain = Promise.resolve();
    const sendEncryptedPlaintext = (plaintext: Uint8Array<ArrayBuffer>) => {
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

    const failChannel = (closeCode: number, reason: string) => {
      logger.warn(`[Relay] data channel failed connectionId=${connectionId} reason=${reason ?? 'unknown'}`);
      teardownDataSocket(connectionId, closeCode, reason);
    };

    const handleMessage = async (data: Buffer, isBinary: boolean) => {
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
          entry.scheduler = action.flowControl ? createDownstreamScheduler<ArrayBuffer>({
            sendBatch: frames => {
              const frame = batchNegotiated ? encodeFrameBatch(frames) : frames[0];
              if (!frame) throw new Error('relay downstream batch is empty');
              return sendEncryptedPlaintext(frame);
            },
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

    const dispatchFrame = (plaintext: Uint8Array<ArrayBuffer>) => {
      const frame = decodeTunnelFrame(plaintext);
      if (frame.frameType === TunnelFrameType.DeliveryAck) {
        if (!entry.scheduler || frame.streamId !== 0 || frame.hasMoreFragments) {
          throw new Error('unexpected delivery acknowledgement');
        }
        entry.scheduler.acknowledge(decodeDeliveryAck(frame.payload));
        return;
      }
      if (!entry.tunnel) throw new Error('relay tunnel is not established');
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

  const handleControlMessage = (raw: string) => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isControlMessage(message)) return;
    if (message.type === 'sync' && Array.isArray(message.connectionIds)) {
      const wanted = new Set(message.connectionIds.filter(isNonemptyConnectionId));
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
    if (message.type === 'connected' && isConnectionId(message.connectionId)) {
      announceClient(message.connectionId);
      openDataSocket(message.connectionId);
      return;
    }
    if (message.type === 'disconnected' && isConnectionId(message.connectionId)) {
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
    let retiredWith: z.infer<typeof relayRetireSchema> | null = null;
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
        } catch (error) {
          void error;
        }
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        void error;
      }
    }, CONTROL_PING_INTERVAL_MS);
    pingTimer.unref();

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
      const info = logger.info;
      if (!info) throw new TypeError('logger.info is not a function');
      info.call(logger, `[Relay] reaping idle data socket connectionId=${connectionId}`);
      teardownDataSocket(connectionId, 1001, 'client idle timeout');
    }
  }, DATA_SOCKET_IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref();

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
