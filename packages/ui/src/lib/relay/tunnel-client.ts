// Relay tunnel client: Layer 1 wiring (relay WS, role=client), Layer 2 E2EE
// initiator, and Layer 3 mux (HTTP/SSE/WS streams) on the client side.
// One relay connection per client session carries all app traffic; a tunnel
// reconnect fails every open stream and the app's existing retry machinery
// (runtime-fetch retries, event-pipeline reconnect) recovers.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md

import { createClientHandshake, type EstablishedChannelCrypto } from './handshake';
import {
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  TunnelFrameType,
  type TunnelHttpRequestPayload,
  type TunnelWsOpenPayload,
} from './protocol';
import {
  chunkPayload,
  createFragmentAssembler,
  createOutboundFrameBatcher,
  createStreamIdAllocator,
  DEFAULT_BATCH_WINDOW_MS,
  decodeFrameBatch,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
  type OutboundFrameBatcher,
  type TunnelFrame,
} from './tunnel-codec';
import { TUNNEL_FRAGMENT_FLAG } from './protocol';
import {
  isHttpResponsePayload,
  isStreamAbortPayload,
  isWsClosePayload,
  normalizeTunnelRequest,
} from './tunnel-payloads';

const EMPTY_PAYLOAD = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

// Minimal wire surface the client needs from the relay WebSocket. Injectable
// so tests can substitute an in-memory transport pair.
export interface TunnelWireSocket {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

const wrapNativeWebSocket = (ws: WebSocket): TunnelWireSocket => {
  ws.binaryType = 'arraybuffer';
  const wire: TunnelWireSocket = {
    get readyState() {
      return ws.readyState;
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => wire.onopen?.();
  ws.onmessage = (event) => wire.onmessage?.({ data: event.data });
  ws.onclose = (event) => wire.onclose?.({ code: event.code, reason: event.reason });
  ws.onerror = () => wire.onerror?.();
  return wire;
};

// Socket-like surface for tunneled WebSockets. Matches exactly what
// packages/ui/src/sync/event-pipeline.ts uses: assignable on* handlers,
// send(), close(), readyState. `wrapBrowserWebSocket` adapts a native
// WebSocket to the same shape so consumers can hold one type for both paths.
export interface RelayTunnelSocketMessageEvent {
  data: string | ArrayBuffer;
}

export interface RelayTunnelSocketCloseEvent {
  code: number;
  reason: string;
}

export interface RelayTunnelWebSocket {
  readonly readyState: number;
  // Native-only hint; the tunnel always delivers binary as ArrayBuffer, so it
  // accepts the setter as a no-op to keep the two socket shapes interchangeable.
  binaryType?: 'blob' | 'arraybuffer';
  onopen: (() => void) | null;
  onmessage: ((event: RelayTunnelSocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: RelayTunnelSocketCloseEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export const wrapBrowserWebSocket = (ws: WebSocket): RelayTunnelWebSocket => {
  const socket: RelayTunnelWebSocket = {
    get readyState() {
      return ws.readyState;
    },
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value) {
      if (value) ws.binaryType = value;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => {
    const data: unknown = event.data;
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      socket.onmessage?.({ data });
    }
  };
  ws.onerror = () => socket.onerror?.();
  ws.onclose = (event) => socket.onclose?.({ code: event.code, reason: event.reason });
  return socket;
};

export type RelayTunnelState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type RelayTunnelFailureClassification = 'network' | 'protocol' | 'crypto' | 'terminal';

export class TunnelChannelReadinessError extends Error {
  constructor(
    message: string,
    readonly failureClassification: RelayTunnelFailureClassification,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TunnelChannelReadinessError';
  }
}

export interface TunnelChannelReadinessContext {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface RelayTunnelStatus {
  state: RelayTunnelState;
  lastError?: string;
  failureClassification?: RelayTunnelFailureClassification;
}

export interface RelayTunnelClientOptions {
  relayUrl?: string;
  serverId?: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
  /** Exact outer WebSocket URL. When omitted, the hosted-relay URL is built as before. */
  outerWebSocketUrl?: string | (() => string);
  /** Transport seam for constructing the outer socket. */
  createOuterWebSocket?: (url: string) => TunnelWireSocket;
  /** Backward-compatible test alias for createOuterWebSocket. */
  createWireSocket?: (url: string) => TunnelWireSocket;
  /** Override which outer close codes are terminal. Hosted-relay defaults are unchanged. */
  isTerminalCloseCode?: (code: number) => boolean;
  /** Override which locally detected failures are terminal. Hosted-relay defaults are unchanged. */
  isTerminalFailureClassification?: (classification: RelayTunnelFailureClassification) => boolean;
  helloRetryMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Frame-batching flush window in ms (default 150). Only applies once negotiated. */
  batchWindowMs?: number;
  /** Advertise frame batching in the handshake. Default true. */
  batch?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  hiddenOrOfflineMaxDelayMs?: number;
  /** Verifies the newly encrypted channel before it is exposed to callers. */
  channelReadiness?: (context: TunnelChannelReadinessContext) => Promise<void>;
}

export interface RelayTunnelClient {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  openWebSocket(pathWithQuery: string, protocols?: string[]): RelayTunnelWebSocket;
  getStatus(): RelayTunnelStatus;
  subscribeStatus(listener: (status: RelayTunnelStatus) => void): () => void;
  close(): void;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// Relay close codes that a reconnect can never resolve — surface a terminal error
// instead of looping forever (auth failed, duplicate client, limit exceeded).
const TERMINAL_RELAY_CLOSE_CODES = new Set<number>([
  RelayCloseCode.AuthFailed,
  RelayCloseCode.DuplicateClient,
  RelayCloseCode.LimitExceeded,
]);

const RELAY_CLOSE_MESSAGES: Record<number, string> = {
  [RelayCloseCode.AuthFailed]: 'relay authentication failed',
  [RelayCloseCode.DuplicateClient]: 'relay connection replaced by another client',
  [RelayCloseCode.LimitExceeded]: 'relay connection limit reached',
};

type StreamHandler = {
  handleFrame(frameType: number, payload: Uint8Array): void;
  fail(error: Error): void;
};

type ActiveChannel = {
  streams: Map<number, StreamHandler>;
  assembler: ReturnType<typeof createFragmentAssembler>;
  nextStreamId(): number;
  send(frame: Uint8Array): void;
  dead: boolean;
};

type ChannelWaiter = {
  resolve(channel: ActiveChannel): void;
  reject(error: Error): void;
};

const isOfflineOrHidden = (): boolean => {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  return offline || hidden;
};

export const createRelayTunnelClient = (options: RelayTunnelClientOptions): RelayTunnelClient => {
  const helloRetryMs = options.helloRetryMs ?? 1_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  // Pong wait after an idle keepalive ping — must be well under the interval so a
  // dead socket is caught within one cycle rather than after two.
  const pingTimeoutMs = options.pingTimeoutMs ?? 15_000;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const advertiseBatch = options.batch !== false;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  const hiddenOrOfflineMaxDelayMs = options.hiddenOrOfflineMaxDelayMs ?? 60_000;

  const createWire = options.createOuterWebSocket
    ?? options.createWireSocket
    ?? ((url: string) => wrapNativeWebSocket(new WebSocket(url)));
  const isTerminalCloseCode = options.isTerminalCloseCode ?? ((code: number) => TERMINAL_RELAY_CLOSE_CODES.has(code));
  const isTerminalFailureClassification = options.isTerminalFailureClassification ?? (() => false);

  let closed = false;
  let status: RelayTunnelStatus = { state: 'idle' };
  // Plain listener set — status must not fan out through shared stores.
  const statusListeners = new Set<(next: RelayTunnelStatus) => void>();
  let activeChannel: ActiveChannel | null = null;
  let currentWire: TunnelWireSocket | null = null;
  let currentAttemptCleanup: (() => void) | null = null;
  let attemptGeneration = 0;
  let consecutiveFailures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let channelWaiters: ChannelWaiter[] = [];
  let wakeListenersInstalled = false;

  const setStatus = (next: RelayTunnelStatus): void => {
    if (status.state === next.state && status.lastError === next.lastError && status.failureClassification === next.failureClassification) return;
    status = next;
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch {
        // A listener throwing must not break the tunnel.
      }
    }
  };

  const rejectWaiters = (error: Error): void => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  };

  const resolveWaiters = (channel: ActiveChannel): void => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.resolve(channel);
  };

  const failChannelStreams = (channel: ActiveChannel, error: Error): void => {
    channel.dead = true;
    const handlers = Array.from(channel.streams.values());
    channel.streams.clear();
    for (const handler of handlers) {
      try {
        handler.fail(error);
      } catch {
        // Stream teardown must not block the rest.
      }
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const onWake = (): void => {
    if (closed || reconnectTimer === null || isOfflineOrHidden()) return;
    clearReconnectTimer();
    removeWakeListeners();
    void connect();
  };

  const onVisibilityWake = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onWake();
  };

  const addWakeListeners = (): void => {
    if (wakeListenersInstalled || typeof window === 'undefined') return;
    wakeListenersInstalled = true;
    window.addEventListener('online', onWake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityWake);
  };

  const removeWakeListeners = (): void => {
    if (!wakeListenersInstalled || typeof window === 'undefined') return;
    wakeListenersInstalled = false;
    window.removeEventListener('online', onWake);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityWake);
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    const attemptIndex = Math.max(0, consecutiveFailures - 1);
    const base = reconnectBaseDelayMs * 2 ** Math.min(attemptIndex, 10);
    // Per CLAUDE.md reconnect pacing: offline/hidden expect recovery from the
    // online/visibility events (interruptible wait below), so back off to the
    // long cap instead of probing a dead network.
    const cap = isOfflineOrHidden() ? hiddenOrOfflineMaxDelayMs : reconnectMaxDelayMs;
    const delay = Math.min(cap, base);
    addWakeListeners();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      removeWakeListeners();
      void connect();
    }, delay);
  };

  const buildRelayWsUrl = (): string => {
    if (options.outerWebSocketUrl) {
      return typeof options.outerWebSocketUrl === 'function' ? options.outerWebSocketUrl() : options.outerWebSocketUrl;
    }
    if (!options.relayUrl || !options.serverId) {
      throw new Error('relayUrl and serverId are required when outerWebSocketUrl is omitted');
    }
    const url = new URL(options.relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', 'client');
    url.searchParams.set('serverId', options.serverId);
    if (options.grant) url.searchParams.set('grant', options.grant);
    return url.toString();
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    clearReconnectTimer();
    attemptGeneration += 1;
    const generation = attemptGeneration;
    setStatus({ state: consecutiveFailures > 0 ? 'reconnecting' : 'connecting', lastError: status.lastError, failureClassification: status.failureClassification });

    let handshake;
    try {
      handshake = await createClientHandshake(options.hostEncPubJwk, { batch: advertiseBatch });
    } catch (error) {
      if (generation !== attemptGeneration || closed) return;
      failAttempt(generation, toError(error), 'crypto', true);
      return;
    }
    if (generation !== attemptGeneration || closed) return;

    let wire: TunnelWireSocket;
    try {
      wire = createWire(buildRelayWsUrl());
    } catch (error) {
      failAttempt(generation, toError(error), 'network');
      return;
    }
    currentWire = wire;

    let settled = false;
    let helloInterval: ReturnType<typeof setInterval> | null = null;
    let helloDeadline: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    // One-shot: armed when an idle-keepalive ping is sent, cleared by any received
    // frame (incl. Pong). If it fires, the tunnel is dead. Independent of the ping
    // cadence so a dead socket is detected ~pingTimeoutMs after an unanswered ping,
    // not on the next full interval.
    let pongDeadline: ReturnType<typeof setTimeout> | null = null;
    let recvChain: Promise<void> = Promise.resolve();
    let channel: ActiveChannel | null = null;
    let cryptoChannel: EstablishedChannelCrypto | null = null;
    let batchNegotiated = false;
    let batcher: OutboundFrameBatcher | null = null;
    // Idle tracking: updated on any non-Ping/Pong frame in EITHER direction.
    // Ping/Pong are excluded so the keepalive can't sustain itself.
    let lastActivityAt = Date.now();

    const cleanupTimers = (): void => {
      if (helloInterval !== null) {
        clearInterval(helloInterval);
        helloInterval = null;
      }
      if (helloDeadline !== null) {
        clearTimeout(helloDeadline);
        helloDeadline = null;
      }
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongDeadline !== null) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
      if (batcher !== null) {
        batcher.dispose();
        batcher = null;
      }
    };
    currentAttemptCleanup = cleanupTimers;

    function failAttemptLocal(
      error: Error,
      failureClassification: RelayTunnelFailureClassification,
      asErrorState = false,
      terminal = false,
    ): void {
      terminal ||= isTerminalFailureClassification(failureClassification);
      if (settled || generation !== attemptGeneration) return;
      settled = true;
      cleanupTimers();
      if (channel) {
        activeChannel = null;
        failChannelStreams(channel, new Error(`relay tunnel reset: ${error.message}`));
      }
      if (terminal) rejectWaiters(error);
      try {
        wire.close();
      } catch {
        // Wire may already be closed.
      }
      if (currentWire === wire) currentWire = null;
      if (closed) return;
      consecutiveFailures += 1;
      // A permanent rejection (auth failed, duplicate, limit) won't resolve by
      // retrying — surface a terminal error instead of reconnecting forever.
      if (terminal) {
        setStatus({ state: 'error', lastError: error.message, failureClassification });
        return;
      }
      setStatus({ state: asErrorState ? 'error' : 'reconnecting', lastError: error.message, failureClassification });
      scheduleReconnect();
    }

    const sendHello = (): void => {
      try {
        wire.send(handshake.helloText);
      } catch {
        // Socket not ready; the retry interval covers it.
      }
    };

    const establish = (crypto: EstablishedChannelCrypto, batch: boolean): void => {
      cryptoChannel = crypto;
      batchNegotiated = batch;
      if (helloInterval !== null) {
        clearInterval(helloInterval);
        helloInterval = null;
      }
      if (helloDeadline !== null) {
        clearTimeout(helloDeadline);
        helloDeadline = null;
      }
      const streams = new Map<number, StreamHandler>();
      const allocator = createStreamIdAllocator();
      const assembler = createFragmentAssembler();
      let sendChain: Promise<void> = Promise.resolve();
      // Serialize encrypt+send: the per-direction IV counter must hit the wire in
      // encryption order or the receiver fails closed. One call == one encrypted
      // WS message == one counter tick, whether it carries a batch or a lone frame.
      const sendEncryptedPlaintext = (plaintext: Uint8Array): void => {
        sendChain = sendChain
          .then(async () => {
            if (channelObj.dead) return;
            const encrypted = await crypto.encryptor.encrypt(plaintext);
            wire.send(encrypted);
          })
          .catch(() => {
            // Send failures surface via wire close; do not break the chain.
          });
      };
      const localBatcher = batch
        ? createOutboundFrameBatcher({ windowMs: batchWindowMs, sendBatch: sendEncryptedPlaintext })
        : null;
      batcher = localBatcher;
      const channelObj: ActiveChannel = {
        streams,
        assembler,
        nextStreamId: () => allocator.next(),
        dead: false,
        send(frame: Uint8Array): void {
          if (channelObj.dead) return;
          const frameType = frame[0] & ~TUNNEL_FRAGMENT_FLAG;
          if (frameType !== TunnelFrameType.Ping && frameType !== TunnelFrameType.Pong) {
            lastActivityAt = Date.now();
          }
          if (localBatcher) localBatcher.enqueue(frame);
          else sendEncryptedPlaintext(frame);
        },
      };
      channel = channelObj;
      lastActivityAt = Date.now();
      const publishChannel = (): void => {
        if (settled || generation !== attemptGeneration || channelObj.dead) return;
        activeChannel = channelObj;
        consecutiveFailures = 0;
        setStatus({ state: 'connected' });
        resolveWaiters(channelObj);
        pingTimer = setInterval(() => {
        const now = Date.now();
        // Only ping when the tunnel has actually been idle; streaming traffic
        // keeps lastActivityAt fresh, so sustained bursts send zero pings.
        if (now - lastActivityAt < pingIntervalMs) return;
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Ping, 0, EMPTY_PAYLOAD));
        // Expect a Pong (or any frame) before the deadline; otherwise it's dead.
        if (pongDeadline === null) {
          pongDeadline = setTimeout(() => {
            pongDeadline = null;
            failAttemptLocal(new Error('relay keepalive timeout'), 'network');
          }, pingTimeoutMs);
        }
        }, pingIntervalMs);
      };
      if (!options.channelReadiness) {
        publishChannel();
        return;
      }
      void options.channelReadiness({
        fetch: (input, init) => tunnelFetchOnChannel(channelObj, input, init),
      }).then(publishChannel).catch((error: unknown) => {
        const readinessError = error instanceof TunnelChannelReadinessError
          ? error
          : new TunnelChannelReadinessError('tunnel channel readiness callback failed', 'terminal', false);
        failAttemptLocal(
          readinessError,
          readinessError.failureClassification,
          !readinessError.retryable,
          !readinessError.retryable,
        );
      });
    };

    const handleTunnelFrame = (channelObj: ActiveChannel, plaintext: Uint8Array): void => {
      let frame: TunnelFrame;
      try {
        frame = decodeTunnelFrame(plaintext);
      } catch (error) {
        failAttemptLocal(toError(error), 'protocol');
        return;
      }
      // Any received frame proves the tunnel is alive — clear the pong deadline.
      if (pongDeadline !== null) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
      if (frame.frameType === TunnelFrameType.Ping) {
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, EMPTY_PAYLOAD));
        return;
      }
      if (frame.frameType === TunnelFrameType.Pong) return;
      // Non-keepalive inbound traffic counts as activity (suppresses our ping).
      lastActivityAt = Date.now();

      let payload = frame.payload;
      if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
        let complete: Uint8Array | null;
        try {
          complete = channelObj.assembler.push(frame);
        } catch (error) {
          failAttemptLocal(toError(error), 'protocol');
          return;
        }
        if (complete === null) return;
        payload = complete;
      } else if (frame.hasMoreFragments) {
        failAttemptLocal(new Error('unexpected fragmented tunnel frame'), 'protocol');
        return;
      }

      const handler = channelObj.streams.get(frame.streamId);
      // Late frames for a stream we already dropped (abort race) are expected.
      if (!handler) return;
      handler.handleFrame(frame.frameType, payload);
    };

    wire.onopen = () => {
      if (settled || generation !== attemptGeneration) return;
      sendHello();
      helloInterval = setInterval(sendHello, helloRetryMs);
    };

    wire.onmessage = (event) => {
      if (settled || generation !== attemptGeneration) return;
      const data = event.data;
      if (typeof data === 'string') {
        recvChain = recvChain
          .then(async () => {
            if (settled || generation !== attemptGeneration) return;
            // Post-establish text frames go through the handshake too: the host
            // re-answers retried hellos with duplicate `ready` frames, which the
            // handshake ignores; anything else fails closed there.
            const action = await handshake.handleText(data);
            if (action.type === 'established') {
              if (cryptoChannel) return;
              establish(action.channel, action.batch);
            } else if (action.type === 'fail') {
              failAttemptLocal(new Error(`relay handshake failed: ${action.reason}`), 'protocol');
            }
          })
          .catch((error: unknown) => {
            failAttemptLocal(toError(error), 'crypto');
          });
        return;
      }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
      if (!bytes) return;
      // Decrypt sequentially: the counter check requires wire order.
      recvChain = recvChain
        .then(async () => {
          if (settled || generation !== attemptGeneration) return;
          const currentChannel = channel;
          const currentCrypto = cryptoChannel;
          if (!currentChannel || !currentCrypto) {
            failAttemptLocal(new Error('encrypted frame before handshake completed'), 'protocol');
            return;
          }
          let plaintext: Uint8Array;
          try {
            plaintext = await currentCrypto.decryptor.decrypt(bytes);
          } catch (error) {
            failAttemptLocal(toError(error), 'crypto');
            return;
          }
          if (batchNegotiated) {
            // One encrypted message may carry several tunnel frames; dispatch
            // each in order through the same per-frame handling as legacy.
            let frames: Uint8Array[];
            try {
              frames = decodeFrameBatch(plaintext);
            } catch (error) {
              failAttemptLocal(toError(error), 'protocol');
              return;
            }
            for (const frame of frames) {
              if (settled || generation !== attemptGeneration || currentChannel.dead) return;
              handleTunnelFrame(currentChannel, frame);
            }
            return;
          }
          handleTunnelFrame(currentChannel, plaintext);
        })
        .catch((error: unknown) => {
          failAttemptLocal(toError(error), 'protocol');
        });
    };

    wire.onclose = (event) => {
      const terminal = isTerminalCloseCode(event.code);
      failAttemptLocal(
        new Error(RELAY_CLOSE_MESSAGES[event.code] ?? `relay socket closed (code ${event.code})`),
        terminal ? 'terminal' : 'network',
        terminal,
        terminal,
      );
    };

    wire.onerror = () => {
      // onclose follows with the failure path.
    };

    helloDeadline = setTimeout(() => {
      helloDeadline = null;
      failAttemptLocal(new Error('relay handshake timeout'), 'network', true);
    }, helloTimeoutMs);

    function failAttempt(gen: number, error: Error, failureClassification: RelayTunnelFailureClassification, asErrorState = false): void {
      if (gen !== attemptGeneration || closed) return;
      if (isTerminalFailureClassification(failureClassification)) {
        rejectWaiters(error);
        consecutiveFailures += 1;
        setStatus({ state: 'error', lastError: error.message, failureClassification });
        return;
      }
      rejectWaiters(error);
      consecutiveFailures += 1;
      setStatus({ state: asErrorState ? 'error' : 'reconnecting', lastError: error.message, failureClassification });
      scheduleReconnect();
    }
  };

  const waitForChannel = (signal?: AbortSignal): Promise<ActiveChannel> => {
    if (closed) return Promise.reject(new Error('relay tunnel closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (activeChannel && !activeChannel.dead) return Promise.resolve(activeChannel);
    return new Promise<ActiveChannel>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const waiter: ChannelWaiter = {
        resolve(channel) {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          resolve(channel);
        },
        reject(error) {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      if (signal) {
        onAbort = () => {
          channelWaiters = channelWaiters.filter((entry) => entry !== waiter);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      channelWaiters.push(waiter);
    });
  };

  const tunnelFetchOnChannel = async (channel: ActiveChannel, input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = await normalizeTunnelRequest(input, init);
    const signal = request.signal;
    if (signal?.aborted) throw abortError();
    const streamId = channel.nextStreamId();

    return await new Promise<Response>((resolve, reject) => {
      let responseDelivered = false;
      let finished = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let onAbort: (() => void) | null = null;

      const cleanupStream = (): void => {
        channel.streams.delete(streamId);
        channel.assembler.dropStream(streamId);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      };

      const finishError = (error: Error): void => {
        if (finished) return;
        finished = true;
        cleanupStream();
        if (!responseDelivered) {
          reject(error);
          return;
        }
        try {
          bodyController?.error(error);
        } catch {
          // Controller may already be closed.
        }
      };

      const sendAbort = (reason: string): void => {
        if (!channel.dead) {
          channel.send(encodeTunnelFrame(TunnelFrameType.StreamAbort, streamId, encodeJsonPayload({ reason })));
        }
      };

      onAbort = () => {
        sendAbort('aborted');
        finishError(abortError());
      };

      channel.streams.set(streamId, {
        handleFrame(frameType, payload) {
          if (frameType === TunnelFrameType.HttpResponse) {
            if (responseDelivered || finished) return;
            let head;
            try {
              head = decodeJsonPayload(payload, isHttpResponsePayload);
            } catch (error) {
              sendAbort('malformed response head');
              finishError(toError(error));
              return;
            }
            const nullBody = head.status === 204 || head.status === 205 || head.status === 304;
            let body: ReadableStream<Uint8Array> | null = null;
            if (!nullBody) {
              body = new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                },
                cancel() {
                  if (finished) return;
                  finished = true;
                  cleanupStream();
                  sendAbort('response body cancelled');
                },
              });
            }
            responseDelivered = true;
            resolve(new Response(body, { status: head.status, headers: head.headers }));
            if (nullBody) {
              finished = true;
              cleanupStream();
            }
            return;
          }
          if (frameType === TunnelFrameType.HttpBody) {
            if (!responseDelivered || finished) return;
            try {
              bodyController?.enqueue(payload);
            } catch {
              // Consumer already cancelled the stream.
            }
            return;
          }
          if (frameType === TunnelFrameType.StreamEnd) {
            if (finished) return;
            if (!responseDelivered) {
              finishError(new Error('tunnel stream ended before response head'));
              return;
            }
            finished = true;
            cleanupStream();
            try {
              bodyController?.close();
            } catch {
              // Consumer already cancelled the stream.
            }
            return;
          }
          if (frameType === TunnelFrameType.StreamAbort) {
            let reason = 'stream aborted by host';
            try {
              reason = decodeJsonPayload(payload, isStreamAbortPayload).reason;
            } catch {
              // Keep the generic reason.
            }
            finishError(new Error(reason));
          }
        },
        fail(error) {
          finishError(error);
        },
      });

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const head: TunnelHttpRequestPayload = {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
      };
      channel.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, streamId, encodeJsonPayload(head)));
      if (request.method === 'GET' || request.method === 'HEAD') return;
      if (request.body === null) {
        channel.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, EMPTY_PAYLOAD));
        return;
      }
      const body = request.body;
      void (async () => {
        try {
          for await (const chunk of body) {
            if (finished || channel.dead) return;
            for (const piece of chunkPayload(chunk)) {
              channel.send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece));
            }
          }
          if (!finished && !channel.dead) {
            channel.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, EMPTY_PAYLOAD));
          }
        } catch (error) {
          sendAbort('request body failed');
          finishError(toError(error));
        }
      })();
    });
  };

  const tunnelFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = input instanceof Request ? input.signal : init?.signal;
    const channel = await waitForChannel(signal ?? undefined);
    return tunnelFetchOnChannel(channel, input, init);
  };

  const splitPathQuery = (pathWithQuery: string): { path: string; query: string } => {
    const index = pathWithQuery.indexOf('?');
    if (index === -1) return { path: pathWithQuery, query: '' };
    return { path: pathWithQuery.slice(0, index), query: pathWithQuery.slice(index + 1) };
  };

  const openTunnelWebSocket = (pathWithQuery: string, protocols?: string[]): RelayTunnelWebSocket => {
    let readyState = WS_CONNECTING;
    let channelRef: ActiveChannel | null = null;
    let streamId = 0;
    let finished = false;

    const socket: RelayTunnelWebSocket = {
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        if (readyState !== WS_OPEN || !channelRef || channelRef.dead) {
          throw new Error('relay tunnel socket is not open');
        }
        if (typeof data === 'string') {
          for (const frame of encodeFragmentedMessage(TunnelFrameType.WsText, streamId, textEncoder.encode(data))) {
            channelRef.send(frame);
          }
          return;
        }
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : (() => {
                const copy = new Uint8Array(data.byteLength);
                copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                return copy;
              })();
        for (const frame of encodeFragmentedMessage(TunnelFrameType.WsBinary, streamId, bytes)) {
          channelRef.send(frame);
        }
      },
      close(code = 1000, reason = '') {
        if (readyState === WS_CLOSED || readyState === WS_CLOSING) return;
        if (readyState === WS_OPEN && channelRef && !channelRef.dead) {
          readyState = WS_CLOSING;
          channelRef.send(encodeTunnelFrame(TunnelFrameType.WsClose, streamId, encodeJsonPayload({ code, reason })));
        }
        settleClose(code, reason);
      },
    };

    const settleClose = (code: number, reason: string, errored = false): void => {
      if (finished) return;
      finished = true;
      if (channelRef) {
        channelRef.streams.delete(streamId);
        channelRef.assembler.dropStream(streamId);
      }
      readyState = WS_CLOSED;
      if (errored) {
        try {
          socket.onerror?.();
        } catch {
          // Handler failures must not break teardown.
        }
      }
      try {
        socket.onclose?.({ code, reason });
      } catch {
        // Handler failures must not break teardown.
      }
    };

    void (async () => {
      let channel: ActiveChannel;
      try {
        channel = await waitForChannel();
      } catch (error) {
        settleClose(1006, toError(error).message, true);
        return;
      }
      if (finished) return;
      channelRef = channel;
      streamId = channel.nextStreamId();
      channel.streams.set(streamId, {
        handleFrame(frameType, payload) {
          if (frameType === TunnelFrameType.WsOpened) {
            if (readyState === WS_CONNECTING) {
              readyState = WS_OPEN;
              try {
                socket.onopen?.();
              } catch {
                // Handler failures must not break the stream.
              }
            }
            return;
          }
          if (frameType === TunnelFrameType.WsText) {
            try {
              socket.onmessage?.({ data: textDecoder.decode(payload) });
            } catch {
              // Handler failures must not break the stream.
            }
            return;
          }
          if (frameType === TunnelFrameType.WsBinary) {
            const buffer = new ArrayBuffer(payload.byteLength);
            new Uint8Array(buffer).set(payload);
            try {
              socket.onmessage?.({ data: buffer });
            } catch {
              // Handler failures must not break the stream.
            }
            return;
          }
          if (frameType === TunnelFrameType.WsClose) {
            let code = 1000;
            let reason = '';
            try {
              const parsed = decodeJsonPayload(payload, isWsClosePayload);
              code = parsed.code;
              reason = parsed.reason;
            } catch {
              // Keep defaults.
            }
            settleClose(code, reason);
            return;
          }
          if (frameType === TunnelFrameType.StreamAbort) {
            let reason = 'stream aborted';
            try {
              reason = decodeJsonPayload(payload, isStreamAbortPayload).reason;
            } catch {
              // Keep the generic reason.
            }
            settleClose(1006, reason, true);
          }
        },
        fail(error) {
          // Spec: streams killed by a tunnel reset close with 1012 so callers'
          // reconnect machinery treats it as "host went away, retry".
          settleClose(1012, error.message, true);
        },
      });
      const { path, query } = splitPathQuery(pathWithQuery);
      // The host sets the WS Origin itself (to the loopback origin it dials); the
      // client's window.location.origin is unreliable in WKWebView, so we don't send it.
      const openPayload: TunnelWsOpenPayload = protocols && protocols.length > 0 ? { path, query, protocols } : { path, query };
      channel.send(encodeTunnelFrame(TunnelFrameType.WsOpen, streamId, encodeJsonPayload(openPayload)));
    })();

    return socket;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    attemptGeneration += 1;
    clearReconnectTimer();
    removeWakeListeners();
    currentAttemptCleanup?.();
    currentAttemptCleanup = null;
    const channel = activeChannel;
    activeChannel = null;
    const error = new Error('relay tunnel closed');
    if (channel) failChannelStreams(channel, error);
    rejectWaiters(error);
    try {
      currentWire?.close();
    } catch {
      // Wire may already be closed.
    }
    currentWire = null;
    setStatus({ state: 'idle' });
  };

  void connect();

  return {
    fetch: tunnelFetch,
    openWebSocket: openTunnelWebSocket,
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    close,
  };
};
