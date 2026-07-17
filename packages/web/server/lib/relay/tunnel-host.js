// Host side of the tunnel mux (Layer 3): consumes decrypted tunnel frames for
// ONE relay connection and dispatches them to the local loopback origin.
// HTTP streams -> fetch http://127.0.0.1:<port> with streamed duplex bodies;
// WS streams -> `ws` client to the loopback WebSocket endpoints.
// The dispatcher NEVER injects credentials: tunneled requests authenticate
// exactly like any remote client (bearer oc_client_* header, oc_url_token query).
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import { WebSocket } from 'ws';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  chunkPayload,
  createFragmentAssembler,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

// Path allowlists (defense in depth; same families realtime-proxy.js allows).
const isAllowedHttpPath = (pathname) =>
  pathname === '/health'
  || pathname === '/api'
  || pathname.startsWith('/api/')
  || pathname === '/auth'
  || pathname.startsWith('/auth/');

const ALLOWED_WS_PATHS = new Set([
  '/api/global/event/ws',
  '/api/event/ws',
  '/api/terminal/ws',
  '/api/dictation/ws',
]);

const canonicalizeTarget = (path, query) => {
  if (typeof path !== 'string' || typeof query !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  if (/[%](?:2f|5c|2e)/i.test(path) || /[\\?#\0-\x1f\x7f]/.test(path) || path.includes('//')) return null;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  if (decoded.split('/').some((part) => part === '.' || part === '..') || /[\\?#\0-\x1f\x7f]/.test(decoded)) return null;
  const url = new URL(`${path}${query ? `?${query}` : ''}`, 'http://loopback.invalid');
  if (url.username || url.password || url.pathname !== path || url.search.slice(1) !== query) return null;
  return { path: url.pathname, query: url.search.slice(1) };
};

// Hop-by-hop headers stripped from tunneled requests; `host` is set by fetch
// to the loopback origin. content-length is dropped too because the body is
// re-chunked through the tunnel and undici computes framing itself.
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const isUntrustedTransportHeader = (name, stripOrigin) =>
  name === 'forwarded'
  || name.startsWith('x-forwarded-')
  || name.startsWith('cf-')
  || name.startsWith('x-openchamber-')
  || (stripOrigin && name === 'origin');

// Response framing headers that no longer apply once the body crosses the
// tunnel as HttpBody chunks (loopback fetch already decoded content-encoding).
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

// v1 backpressure rule: pause reading the loopback source while the outbound
// relay socket has more than this buffered.
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 20;
const COMPLETED_HTTP_STREAM_TTL_MS = 5_000;
const MAX_COMPLETED_HTTP_STREAMS = 256;
const MAX_LATE_HTTP_BODY_FRAMES = 32;
const MAX_LATE_HTTP_BODY_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isHttpRequestPayload = (parsed) =>
  Boolean(parsed && typeof parsed === 'object'
    && typeof parsed.method === 'string'
    && typeof parsed.path === 'string'
    && typeof parsed.query === 'string'
    && parsed.headers && typeof parsed.headers === 'object');

const isWsOpenPayload = (parsed) =>
  Boolean(parsed && typeof parsed === 'object'
    && typeof parsed.path === 'string'
    && typeof parsed.query === 'string'
    && (parsed.protocols === undefined || Array.isArray(parsed.protocols)));

const isWsClosePayload = (parsed) => Boolean(parsed && typeof parsed === 'object');

/**
 * @param {{
 *   connectionId: string,
 *   getLocalPort: () => number,
 *   sendFrame: (plaintextFrame: Uint8Array) => void | Promise<void>,
 *   getBufferedAmount: () => number,
 *   transportContext?: { requestHeaders?: Record<string, string>, wsHeaders?: Record<string, string>, metadataHeader?: string | null, stripOrigin?: boolean },
 *   requestPolicy?: (request: { kind: 'http' | 'ws', streamId: number, generation: number, method?: string, path: string, query: string, headers?: Record<string, string> }) => boolean | string | Promise<boolean | string>,
 *   onRequest?: (request: object) => void,
 *   onResponse?: (response: { kind: 'http', streamId: number, generation: number, status: number }) => void | Promise<void>,
 *   onLimitExceeded?: (reason: string) => void,
 *   onStreamClosed?: (event: { streamId: number, generation: number, kind: 'http' | 'ws', reason: string }) => void,
 *   limits?: { maxStreams?: number, maxWebSockets?: number, maxIncompleteFragments?: number, maxIncompleteFragmentBytes?: number, getMaxIncompleteFragmentBytes?: () => number, maxStreamOpens?: number, streamOpenWindowMs?: number, completedHttpStreamTtlMs?: number, maxCompletedHttpStreams?: number, maxLateHttpBodyFrames?: number, maxLateHttpBodyBytes?: number, now?: () => number },
 *   failClosedPolicy?: boolean,
 *   onProtocolFailure?: () => void,
 * }} deps
 */
export const createTunnelHost = ({
  connectionId,
  getLocalPort,
  sendFrame,
  getBufferedAmount,
  transportContext = {},
  requestPolicy,
  onRequest,
  onResponse,
  onLimitExceeded,
  onStreamClosed,
  limits = {},
  failClosedPolicy = false,
  onProtocolFailure,
}) => {
  /** @type {Map<number, { kind: 'http', abort: AbortController, body: ReadableStreamDefaultController | null, requestBody: ReadableStream | undefined, responseBody: ReadableStream | null, noBody: boolean } | { kind: 'ws', socket: WebSocket, opened: boolean }>} */
  const streams = new Map();
  const assembler = createFragmentAssembler();
  const incompleteFragments = new Set();
  /** @type {Map<number, { expiresAt: number, bodyCapable: boolean, lateBodyFrames: number, lateBodyBytes: number }>} */
  const completedHttpStreams = new Map();
  let closed = false;
  const streamOpenTimes = [];
  let nextGeneration = 1;

  const now = limits.now ?? Date.now;
  const completedHttpStreamTtlMs = Number.isFinite(limits.completedHttpStreamTtlMs)
    ? Math.max(0, limits.completedHttpStreamTtlMs)
    : COMPLETED_HTTP_STREAM_TTL_MS;
  const maxCompletedHttpStreams = Number.isFinite(limits.maxCompletedHttpStreams)
    ? Math.max(0, Math.floor(limits.maxCompletedHttpStreams))
    : MAX_COMPLETED_HTTP_STREAMS;
  const maxLateHttpBodyFrames = Number.isFinite(limits.maxLateHttpBodyFrames)
    ? Math.max(0, Math.floor(limits.maxLateHttpBodyFrames))
    : MAX_LATE_HTTP_BODY_FRAMES;
  const maxLateHttpBodyBytes = Number.isFinite(limits.maxLateHttpBodyBytes)
    ? Math.max(0, limits.maxLateHttpBodyBytes)
    : MAX_LATE_HTTP_BODY_BYTES;

  const pruneCompletedHttpStreams = () => {
    const currentTime = now();
    for (const [streamId, tombstone] of completedHttpStreams) {
      if (tombstone.expiresAt > currentTime) continue;
      completedHttpStreams.delete(streamId);
    }
  };

  const recordCompletedHttpStream = (streamId, stream) => {
    pruneCompletedHttpStreams();
    if (maxCompletedHttpStreams === 0 || completedHttpStreamTtlMs === 0) return;
    while (completedHttpStreams.size >= maxCompletedHttpStreams) {
      completedHttpStreams.delete(completedHttpStreams.keys().next().value);
    }
    completedHttpStreams.set(streamId, {
      expiresAt: now() + completedHttpStreamTtlMs,
      bodyCapable: !stream.noBody,
      lateBodyFrames: 0,
      lateBodyBytes: 0,
    });
  };

  const getCompletedHttpStream = (streamId) => {
    pruneCompletedHttpStreams();
    return completedHttpStreams.get(streamId);
  };

  const send = async (frame) => {
    if (closed) return;
    await sendFrame(frame);
  };

  const sendJson = (frameType, streamId, payload) =>
    send(encodeTunnelFrame(frameType, streamId, encodeJsonPayload(payload)));

  const sendAbort = async (streamId, reason) => {
    await sendJson(TunnelFrameType.StreamAbort, streamId, { reason: String(reason ?? 'stream error') });
  };

  const dropStream = (streamId, reason = 'completed') => {
    const stream = streams.get(streamId);
    if (reason === 'completed' && stream?.kind === 'http') recordCompletedHttpStream(streamId, stream);
    streams.delete(streamId);
    assembler.dropStream(streamId);
    for (const key of incompleteFragments) {
      if (key.startsWith(`${streamId}:`)) incompleteFragments.delete(key);
    }
    if (stream) onStreamClosed?.({ streamId, generation: stream.generation, kind: stream.kind, reason });
  };

  const abortLocalStream = (streamId, reason) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    dropStream(streamId, String(reason ?? 'aborted'));
    if (stream.kind === 'http') {
      stream.abort.abort();
      void stream.responseBody?.cancel().catch(() => {});
    } else {
      try {
        stream.socket.terminate();
      } catch {
        // socket already gone
      }
    }
  };

  const waitForBackpressure = async (signal) => {
    while (!closed && getBufferedAmount() > BACKPRESSURE_LIMIT_BYTES) {
      if (signal?.aborted) return;
      await sleep(BACKPRESSURE_POLL_MS);
    }
  };

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const buildRequestHeaders = (rawHeaders) => {
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower) || isUntrustedTransportHeader(lower, transportContext.stripOrigin === true)) continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
      headers[lower] = value;
    }
    const metadataHeader = transportContext.metadataHeader === undefined
      ? 'x-openchamber-relay-connection'
      : transportContext.metadataHeader;
    if (metadataHeader) headers[metadataHeader.toLowerCase()] = connectionId;
    for (const [name, value] of Object.entries(transportContext.requestHeaders ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    return headers;
  };

  const policyRejection = async (request) => {
    onRequest?.(request);
    const result = await requestPolicy?.(request);
    if (result === false) return 'Request rejected by transport policy';
    return typeof result === 'string' ? result : null;
  };

  const exceedsOpenRate = () => {
    if (!Number.isFinite(limits.maxStreamOpens)) return false;
    const now = Date.now();
    const windowMs = Number.isFinite(limits.streamOpenWindowMs) ? limits.streamOpenWindowMs : 10_000;
    while (streamOpenTimes.length > 0 && now - streamOpenTimes[0] >= windowMs) streamOpenTimes.shift();
    if (streamOpenTimes.length >= limits.maxStreamOpens) return true;
    streamOpenTimes.push(now);
    return false;
  };

  const atStreamLimit = (kind) => {
    if (Number.isFinite(limits.maxStreams) && streams.size >= limits.maxStreams) return true;
    if (kind !== 'ws' || !Number.isFinite(limits.maxWebSockets)) return false;
    let count = 0;
    for (const stream of streams.values()) if (stream.kind === 'ws') count += 1;
    return count >= limits.maxWebSockets;
  };

  // Synthetic responses never ship an empty body: `reason` states explicitly
  // that the relay host (not the upstream server) produced this response.
  const syntheticResponse = async (streamId, status, message) => {
    await sendJson(TunnelFrameType.HttpResponse, streamId, {
      status,
      headers: { 'content-type': 'application/json' },
    });
    await send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, encodeJsonPayload({ error: message, reason: message, source: 'relay-tunnel-host' })));
    await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
  };

  const runHttpStream = async (streamId, request) => {
    const target = canonicalizeTarget(request.path, request.query);
    if (!target) throw new Error('invalid request target');
    request.path = target.path;
    request.query = target.query;
    const method = request.method.toUpperCase();
    if (!isAllowedHttpPath(request.path)) {
      dropStream(streamId, 'path-rejected');
      if (failClosedPolicy) throw new Error('path rejected');
      await syntheticResponse(streamId, 403, 'Path is not allowed through the relay');
      return;
    }
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;
    const rejected = await policyRejection({ kind: 'http', streamId, generation: stream.generation, method, path: request.path, query: request.query, headers: request.headers });
    if (rejected) {
      dropStream(streamId, 'policy-rejected');
      if (failClosedPolicy) throw new Error('request rejected by transport policy');
      await syntheticResponse(streamId, 403, rejected);
      return;
    }

    const hasBody = !stream.noBody;

    const url = `http://127.0.0.1:${getLocalPort()}${request.path}${request.query ? `?${request.query}` : ''}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: buildRequestHeaders(request.headers),
        body: stream.requestBody,
        duplex: hasBody ? 'half' : undefined,
        signal: stream.abort.signal,
      });
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId, 'request-failed');
        await sendAbort(streamId, error?.message ?? 'loopback request failed');
      }
      return;
    }
    stream.responseBody = response.body;

    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
      responseHeaders[name] = value;
    }
    await sendJson(TunnelFrameType.HttpResponse, streamId, { status: response.status, headers: responseHeaders });
    await onResponse?.({ kind: 'http', streamId, generation: stream.generation, status: response.status });

    try {
      if (response.body) {
        for await (const chunk of response.body) {
          if (closed || stream.abort.signal.aborted) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          for (const piece of chunkPayload(bytes, MAX_TUNNEL_PAYLOAD_BYTES)) {
            await waitForBackpressure(stream.abort.signal);
            if (closed || stream.abort.signal.aborted) return;
            await send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece));
          }
        }
      }
      if (streams.get(streamId) === stream) {
        dropStream(streamId, 'completed');
        await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
      }
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId, 'response-failed');
        await sendAbort(streamId, error?.message ?? 'loopback response failed');
      }
    }
  };

  const handleHttpRequest = (streamId, payload) => {
    if (getCompletedHttpStream(streamId)) throw new Error('completed stream id reused');
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let request;
    try {
      request = decodeJsonPayload(payload, isHttpRequestPayload);
    } catch (error) {
      if (failClosedPolicy) throw error;
      void sendAbort(streamId, error?.message ?? 'malformed request');
      return;
    }
    const method = request.method.toUpperCase();
    const stream = {
      kind: 'http',
      generation: nextGeneration++,
      abort: new AbortController(),
      body: null,
      requestBody: undefined,
      responseBody: null,
      noBody: method === 'GET' || method === 'HEAD',
    };
    if (!stream.noBody) {
      stream.requestBody = new ReadableStream({
        start(controller) {
          stream.body = controller;
        },
      });
    }
    if (atStreamLimit('http')) {
      onLimitExceeded?.('stream-limit');
      void sendAbort(streamId, 'stream limit exceeded');
      return;
    }
    if (exceedsOpenRate()) {
      onLimitExceeded?.('stream-open-rate');
      void sendAbort(streamId, 'stream open rate exceeded');
      return;
    }
    streams.set(streamId, stream);
    void runHttpStream(streamId, request).catch(() => onProtocolFailure?.());
  };

  const handleHttpBody = (streamId, payload) => {
    const stream = streams.get(streamId);
    if (!stream) {
      const tombstone = getCompletedHttpStream(streamId);
      if (!tombstone?.bodyCapable) throw new Error('unsolicited http body');
      const nextFrames = tombstone.lateBodyFrames + 1;
      const nextBytes = tombstone.lateBodyBytes + payload.byteLength;
      if (nextFrames > maxLateHttpBodyFrames || nextBytes > maxLateHttpBodyBytes) {
        throw new Error('late http body budget exceeded');
      }
      tombstone.lateBodyFrames = nextFrames;
      tombstone.lateBodyBytes = nextBytes;
      return;
    }
    if (stream.kind !== 'http' || stream.noBody) throw new Error('unsolicited http body');
    // The body controller attaches synchronously when the stream opens, before
    // policy evaluation or loopback dispatch can await.
    try {
      stream.body?.enqueue(payload);
    } catch {
      // stream already errored/closed
    }
  };

  const handleStreamEnd = (streamId) => {
    const stream = streams.get(streamId);
    if (!stream) {
      if (!getCompletedHttpStream(streamId)) throw new Error('unsolicited stream end');
      completedHttpStreams.delete(streamId);
      return;
    }
    if (stream.kind !== 'http') throw new Error('unsolicited stream end');
    try {
      stream.body?.close();
    } catch {
      // stream already errored/closed
    }
    // Response side keeps running; only the request body is half-closed.
  };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  const handleWsOpen = async (streamId, payload) => {
    if (getCompletedHttpStream(streamId)) throw new Error('completed stream id reused');
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let open;
    try {
      open = decodeJsonPayload(payload, isWsOpenPayload);
    } catch (error) {
      if (failClosedPolicy) throw error;
      void sendAbort(streamId, error?.message ?? 'malformed ws open');
      return;
    }
    const target = canonicalizeTarget(open.path, open.query);
    if (!target) throw new Error('invalid websocket target');
    open.path = target.path;
    open.query = target.query;
    if (!ALLOWED_WS_PATHS.has(open.path)) {
      if (failClosedPolicy) throw new Error('path rejected');
      void sendAbort(streamId, 'Path is not allowed through the relay');
      return;
    }
    const generation = nextGeneration++;
    const rejected = await policyRejection({ kind: 'ws', streamId, generation, path: open.path, query: open.query });
    if (rejected) {
      if (failClosedPolicy) throw new Error('request rejected by transport policy');
      void sendAbort(streamId, rejected);
      return;
    }
    if (atStreamLimit('ws')) {
      onLimitExceeded?.('websocket-limit');
      void sendAbort(streamId, 'stream limit exceeded');
      return;
    }
    if (exceedsOpenRate()) {
      onLimitExceeded?.('stream-open-rate');
      void sendAbort(streamId, 'stream open rate exceeded');
      return;
    }

    const url = `ws://127.0.0.1:${getLocalPort()}${open.path}${open.query ? `?${open.query}` : ''}`;
    // Present the loopback origin we're actually dialing. The server derives this
    // as a trusted same-origin candidate from the Host header (127.0.0.1:<port>),
    // so the WS origin check passes reliably for every client platform. We do NOT
    // use the client's window.location.origin: it's unreliable in WKWebView (empty
    // or "null" for custom schemes), and the `ws` client sends no Origin at all
    // otherwise — a no-origin upgrade is rejected 403. The request itself is still
    // authenticated by the tunneled oc_url_token, not by this origin.
    const dialHeaders = {
      origin: `http://127.0.0.1:${getLocalPort()}`,
    };
    const metadataHeader = transportContext.metadataHeader === undefined
      ? 'x-openchamber-relay-connection'
      : transportContext.metadataHeader;
    if (metadataHeader) dialHeaders[metadataHeader.toLowerCase()] = connectionId;
    Object.assign(dialHeaders, transportContext.wsHeaders ?? {});
    let socket;
    try {
      socket = new WebSocket(url, open.protocols, {
        headers: dialHeaders,
      });
    } catch (error) {
      void sendAbort(streamId, error?.message ?? 'ws dial failed');
      return;
    }
    const stream = { kind: 'ws', generation, socket, opened: false, sendChain: Promise.resolve() };
    streams.set(streamId, stream);

    socket.on('open', () => {
      if (streams.get(streamId) !== stream) return;
      stream.opened = true;
      void sendJson(TunnelFrameType.WsOpened, streamId, socket.protocol ? { protocol: socket.protocol } : {});
    });
    socket.on('message', (data, isBinary) => {
      if (streams.get(streamId) !== stream || closed) return;
      const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(Buffer.concat(data));
      const frameType = isBinary ? TunnelFrameType.WsBinary : TunnelFrameType.WsText;
      stream.sendChain = stream.sendChain.then(async () => {
        for (const frame of encodeFragmentedMessage(frameType, streamId, bytes)) {
          await waitForBackpressure(null);
          if (streams.get(streamId) !== stream || closed) return;
          await send(frame);
        }
      }).catch(() => {
        if (streams.get(streamId) !== stream) return;
        abortLocalStream(streamId, 'send-failed');
        onProtocolFailure?.();
      });
    });
    socket.on('close', (code, reasonBuffer) => {
      if (streams.get(streamId) !== stream) return;
      dropStream(streamId, 'upstream-closed');
      const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
      if (stream.opened) {
        void sendJson(TunnelFrameType.WsClose, streamId, { code: code || 1000, reason });
      } else {
        void sendAbort(streamId, reason || `upstream ws closed (${code || 'no code'})`);
      }
    });
    socket.on('error', (error) => {
      if (streams.get(streamId) !== stream) return;
      if (!stream.opened) {
        dropStream(streamId, 'upstream-error');
        try {
          socket.terminate();
        } catch {
          // already gone
        }
        void sendAbort(streamId, error?.message ?? 'upstream ws error');
      }
      // Post-open errors are followed by 'close', handled above.
    });
  };

  const handleWsMessage = (streamId, frameType, message) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws' || !stream.opened || stream.socket.readyState !== WebSocket.OPEN) throw new Error('unsolicited websocket data');
    if (frameType === TunnelFrameType.WsText) {
      stream.socket.send(Buffer.from(message).toString('utf8'));
    } else {
      stream.socket.send(message, { binary: true });
    }
  };

  const handleWsClose = (streamId, payload) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws') return;
    dropStream(streamId, 'closed-by-client');
    let close = { code: 1000, reason: '' };
    try {
      close = decodeJsonPayload(payload, isWsClosePayload);
    } catch {
      // fall through with defaults
    }
    const code = Number.isInteger(close.code) && close.code >= 1000 && close.code <= 4999 ? close.code : 1000;
    try {
      stream.socket.close(code, typeof close.reason === 'string' ? close.reason : '');
    } catch {
      stream.socket.terminate();
    }
  };

  // -------------------------------------------------------------------------
  // Frame entrypoint
  // -------------------------------------------------------------------------

  /** @param {Uint8Array} plaintextFrame one decrypted tunnel frame */
  const handleFrame = async (plaintextFrame) => {
    if (closed) return;
    const frame = decodeTunnelFrame(plaintextFrame);

    // WS message frames can be fragmented; everything else arrives whole.
    if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
      const stream = streams.get(frame.streamId);
      if (!stream || stream.kind !== 'ws' || !stream.opened || stream.socket.readyState !== WebSocket.OPEN) {
        throw new Error('unsolicited websocket data');
      }
      const fragmentKey = `${frame.streamId}:${frame.frameType}`;
      if (frame.hasMoreFragments && !incompleteFragments.has(fragmentKey)) {
        if (Number.isFinite(limits.maxIncompleteFragments) && incompleteFragments.size >= limits.maxIncompleteFragments) {
          onLimitExceeded?.('fragment-limit');
          await sendAbort(frame.streamId, 'incomplete fragment limit exceeded');
          return;
        }
        incompleteFragments.add(fragmentKey);
      }
      const message = assembler.push(frame);
      const fragmentByteLimit = limits.getMaxIncompleteFragmentBytes?.() ?? limits.maxIncompleteFragmentBytes;
      if (Number.isFinite(fragmentByteLimit) && assembler.pendingBytes > fragmentByteLimit) {
        throw new Error('incomplete fragment byte limit exceeded');
      }
      if (message === null) return;
      incompleteFragments.delete(fragmentKey);
      handleWsMessage(frame.streamId, frame.frameType, message);
      return;
    }

    switch (frame.frameType) {
      case TunnelFrameType.HttpRequest:
        handleHttpRequest(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.HttpBody:
        handleHttpBody(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.StreamEnd:
        handleStreamEnd(frame.streamId);
        return;
      case TunnelFrameType.StreamAbort:
        abortLocalStream(frame.streamId, 'aborted by client');
        return;
      case TunnelFrameType.WsOpen:
        await handleWsOpen(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.WsClose:
        handleWsClose(frame.streamId, frame.payload);
        return;
      case TunnelFrameType.Ping:
        await send(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, new Uint8Array(0)));
        return;
      case TunnelFrameType.Pong:
        return;
      default:
        throw new Error('prohibited tunnel frame');
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const streamId of [...streams.keys()]) {
      abortLocalStream(streamId, 'connection closed');
    }
    streams.clear();
    completedHttpStreams.clear();
    incompleteFragments.clear();
    assembler.clear();
  };

  return {
    handleFrame,
    close,
    get streamCount() {
      return streams.size;
    },
    get completedHttpStreamCount() {
      pruneCompletedHttpStreams();
      return completedHttpStreams.size;
    },
  };
};
