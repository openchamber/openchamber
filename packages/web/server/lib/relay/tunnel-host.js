
import { Readable, pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import { WebSocket } from 'ws';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  chunkPayload,
  createFragmentAssembler,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

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
  '/api/dev-tunnel',
]);
const GUEST_SURFACE_WS_PATH = /^\/api\/guests\/[a-z][a-z0-9-]*\/surface\/ws$/;
const SPACE_WS_PATH = /^\/api\/spaces\/[0-9a-f]{12}\/(?:terminal\/ws|dev-tunnel|event\/ws|global\/event\/ws)$/;
export const isAllowedRelayWebSocketPath = (pathname) => ALLOWED_WS_PATHS.has(pathname) || GUEST_SURFACE_WS_PATH.test(pathname) || SPACE_WS_PATH.test(pathname);

const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

const TUNNEL_ACCEPT_ENCODING_HEADER = 'x-openchamber-tunnel-accept-encoding';
const TUNNEL_CONTENT_ENCODING_HEADER = 'x-openchamber-tunnel-content-encoding';
const COMPRESSION_MIN_BYTES = 1024;
const COMPRESSIBLE_CONTENT_TYPE = /^(?:application\/(?:json|[\w.+-]+\+json|javascript|xml|[\w.+-]+\+xml)|text\/(?!event-stream)[\w.+-]+|image\/svg\+xml)\s*(?:;|$)/i;

const shouldCompressResponse = (request, method, response) => {
  if (method === 'HEAD' || !response.body) return false;
  const accepted = Object.entries(request.headers ?? {})
    .find(([name]) => name.toLowerCase() === TUNNEL_ACCEPT_ENCODING_HEADER)?.[1];
  if (accepted !== 'gzip') return false;
  if (!COMPRESSIBLE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) return false;
  const length = Number(response.headers.get('content-length'));
  return !(Number.isFinite(length) && length > 0 && length < COMPRESSION_MIN_BYTES);
};

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 20;

const BODY_BUFFER_MAX_BYTES = 512 * 1024;
const BODY_DELIVERY_TIMEOUT_MS = 15_000;
const MAX_PENDING_WS_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_WS_MESSAGES = 1024;
// external: https://github.com/oven-sh/bun/blob/bun-v1.3.0/src/js/thirdparty/ws.js Bun's ws shim cannot pause reads, so its downstream WS queue aborts the substream on overflow.
const CAN_PAUSE_WS_READS = !process.versions.bun;

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
 *   bodyDeliveryTimeoutMs?: number,
 *   responseChunkBytes?: number,
 *   cancelPendingFrames?: (streamId: number) => void,
 * }} deps
 */
export const createTunnelHost = ({ connectionId, getLocalPort, sendFrame, getBufferedAmount, bodyDeliveryTimeoutMs = BODY_DELIVERY_TIMEOUT_MS, responseChunkBytes = MAX_TUNNEL_PAYLOAD_BYTES, cancelPendingFrames = () => {} }) => {
  /** @type {Map<number, { kind: 'http', abort: AbortController, body: { enqueue(payload: Uint8Array): void, close(): void, error(error: Error): void } | null, noBody: boolean } | { kind: 'ws', socket: WebSocket, opened: boolean }>} */
  const streams = new Map();
  const assembler = createFragmentAssembler();
  let closed = false;
  let pendingWsBytes = 0;
  let pendingWsMessages = 0;

  const send = async (frame) => {
    if (closed) return;
    await sendFrame(frame);
  };

  const sendJson = (frameType, streamId, payload) =>
    send(encodeTunnelFrame(frameType, streamId, encodeJsonPayload(payload)));

  const sendAbort = async (streamId, reason) => {
    await sendJson(TunnelFrameType.StreamAbort, streamId, { reason: String(reason ?? 'stream error') });
  };

  const dropStream = (streamId) => {
    streams.delete(streamId);
    assembler.dropStream(streamId);
  };

  const abortLocalStream = (streamId, reason) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    dropStream(streamId);
    cancelPendingFrames(streamId);
    if (stream.kind === 'http') {
      try {
        stream.body?.error(new Error(String(reason ?? 'aborted')));
      } catch {
        // body already closed
      }
      stream.abort.abort();
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


  const buildRequestHeaders = (rawHeaders, loopbackOrigin) => {
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower) || lower === TUNNEL_ACCEPT_ENCODING_HEADER) continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
      headers[lower] = value;
    }
    headers['x-openchamber-relay-connection'] = connectionId;
    headers['accept-encoding'] = 'identity';
    headers.origin = loopbackOrigin;
    return headers;
  };

  const syntheticResponse = async (streamId, status, message) => {
    await sendJson(TunnelFrameType.HttpResponse, streamId, {
      status,
      headers: { 'content-type': 'application/json' },
    });
    await send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, encodeJsonPayload({ error: message, reason: message, source: 'relay-tunnel-host' })));
    await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
  };

  const forwardRequest = async (streamId, stream, url, method, request, body, loopbackOrigin) => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: buildRequestHeaders(request.headers, loopbackOrigin),
        body,
        duplex: body ? 'half' : undefined,
        signal: stream.abort.signal,
      });
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await sendAbort(streamId, error?.message ?? 'loopback request failed');
      }
      return;
    }

    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
      responseHeaders[name] = value;
    }
    if (closed || stream.abort.signal.aborted) {
      await response.body?.cancel();
      return;
    }
    const compress = shouldCompressResponse(request, method, response);
    if (compress) responseHeaders[TUNNEL_CONTENT_ENCODING_HEADER] = 'gzip';
    // external: https://github.com/nodejs/node/blob/main/lib/internal/webstreams/adapters.js CompressionStream cancellation during gzip output raises "Controller is already closed"; a Node pipeline handles teardown.
    const responseBody = compress
      ? pipeline(Readable.fromWeb(response.body), createGzip(), () => {})
      : response.body;

    try {
      await sendJson(TunnelFrameType.HttpResponse, streamId, { status: response.status, headers: responseHeaders });
      if (responseBody) {
        for await (const chunk of responseBody) {
          if (closed || stream.abort.signal.aborted) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const pieces = chunkPayload(bytes, responseChunkBytes);
          const groupSize = Math.max(1, Math.floor(MAX_TUNNEL_PAYLOAD_BYTES / responseChunkBytes));
          for (let offset = 0; offset < pieces.length; offset += groupSize) {
            await waitForBackpressure(stream.abort.signal);
            if (closed || stream.abort.signal.aborted) return;
            await Promise.all(pieces.slice(offset, offset + groupSize).map(piece =>
              send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece))));
          }
        }
      }
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
      }
    } catch (error) {
      if (streams.get(streamId) === stream) {
        dropStream(streamId);
        await sendAbort(streamId, error?.message ?? 'loopback response failed');
      }
    }
  };

  const runHttpStream = async (streamId, request) => {
    const method = request.method.toUpperCase();
    if (!isAllowedHttpPath(request.path)) {
      dropStream(streamId);
      await syntheticResponse(streamId, 403, 'Path is not allowed through the relay');
      return;
    }

    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const loopbackOrigin = `http://127.0.0.1:${getLocalPort()}`;
    const url = `${loopbackOrigin}${request.path}${request.query ? `?${request.query}` : ''}`;

    if (!hasBody) {
      stream.noBody = true;
      await forwardRequest(streamId, stream, url, method, request, null, loopbackOrigin);
      return;
    }

    const buffered = [];
    let bufferedBytes = 0;
    let bodyFrameCount = 0;
    let liveStream = null;
    let liveController = null;
    let completed = false;
    let bodyFailure = null;
    let resolveBodyEnd;
    const bodyEnded = new Promise((resolve) => { resolveBodyEnd = resolve; });

    const finishBody = (error) => {
      if (completed) return;
      completed = true;
      bodyFailure = error ?? null;
      if (liveController) {
        try {
          if (error) liveController.error(error);
          else liveController.close();
        } catch {
          // stream already errored/closed
        }
      }
      resolveBodyEnd();
    };

    let deliveryDeadline = null;
    const switchToLive = () => {
      liveStream = new ReadableStream({
        start(controller) {
          liveController = controller;
          stream.body = controller;
        },
      });
      for (const chunk of buffered) {
        try { liveController.enqueue(chunk); } catch { break; }
      }
      buffered.length = 0;
      if (deliveryDeadline) clearTimeout(deliveryDeadline);
      resolveBodyEnd();
      void forwardRequest(streamId, stream, url, method, request, liveStream, loopbackOrigin);
    };

    stream.body = {
      enqueue(payload) {
        if (completed) return;
        bodyFrameCount += 1;
        if (liveController) {
          try { liveController.enqueue(payload); } catch {
            // stream already errored/closed
          }
          return;
        }
        buffered.push(payload);
        bufferedBytes += payload.length;
        if (bufferedBytes > BODY_BUFFER_MAX_BYTES) {
          switchToLive();
        }
      },
      close() {
        finishBody(null);
      },
      error(error) {
        finishBody(error);
      },
    };

    deliveryDeadline = setTimeout(() => {
      if (streams.get(streamId) === stream && !completed && !liveStream) {
        dropStream(streamId);
        void sendAbort(streamId, 'tunnel request body was not delivered in time');
        finishBody(new Error('tunnel request body was not delivered in time'));
      }
    }, bodyDeliveryTimeoutMs);
    deliveryDeadline.unref?.();

    await bodyEnded;
    if (deliveryDeadline) clearTimeout(deliveryDeadline);
    if (streams.get(streamId) !== stream) return;
    if (bodyFailure) {
      dropStream(streamId);
      await sendAbort(streamId, bodyFailure.message ?? 'tunnel request body failed');
      return;
    }
    if (liveStream) return;

    if (request.hasBody === true && bodyFrameCount === 0) {
      dropStream(streamId);
      await sendAbort(streamId, 'tunnel request body frames were lost');
      return;
    }

    stream.body = null;
    await forwardRequest(streamId, stream, url, method, request, Buffer.concat(buffered), loopbackOrigin);
  };

  const handleHttpRequest = (streamId, payload) => {
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let request;
    try {
      request = decodeJsonPayload(payload, isHttpRequestPayload);
    } catch (error) {
      void sendAbort(streamId, error?.message ?? 'malformed request');
      return;
    }
    const stream = { kind: 'http', abort: new AbortController(), body: null, noBody: false };
    streams.set(streamId, stream);
    void runHttpStream(streamId, request);
  };

  const handleHttpBody = (streamId, payload) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http' || stream.noBody) return;
    try {
      stream.body?.enqueue(payload);
    } catch {
      // stream already errored/closed
    }
  };

  const handleStreamEnd = (streamId) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;
    try {
      stream.body?.close();
    } catch {
      // stream already errored/closed
    }
  };


  const handleWsOpen = (streamId, payload) => {
    if (streams.has(streamId)) {
      abortLocalStream(streamId, 'duplicate stream id');
      void sendAbort(streamId, 'duplicate stream id');
      return;
    }
    let open;
    try {
      open = decodeJsonPayload(payload, isWsOpenPayload);
    } catch (error) {
      void sendAbort(streamId, error?.message ?? 'malformed ws open');
      return;
    }
    if (!isAllowedRelayWebSocketPath(open.path)) {
      void sendAbort(streamId, 'Path is not allowed through the relay');
      return;
    }

    const url = `ws://127.0.0.1:${getLocalPort()}${open.path}${open.query ? `?${open.query}` : ''}`;
    const dialHeaders = {
      'x-openchamber-relay-connection': connectionId,
      origin: `http://127.0.0.1:${getLocalPort()}`,
    };
    let socket;
    try {
      socket = new WebSocket(url, open.protocols, {
        headers: dialHeaders,
        maxPayload: MAX_PENDING_WS_BYTES,
      });
    } catch (error) {
      void sendAbort(streamId, error?.message ?? 'ws dial failed');
      return;
    }
    const stream = { kind: 'ws', socket, opened: false };
    streams.set(streamId, stream);
    let outputChain = Promise.resolve();
    let socketPendingMessages = 0;

    socket.on('open', () => {
      if (streams.get(streamId) !== stream) return;
      stream.opened = true;
      void sendJson(TunnelFrameType.WsOpened, streamId, socket.protocol ? { protocol: socket.protocol } : {});
    });
    socket.on('message', (data, isBinary) => {
      if (streams.get(streamId) !== stream || closed) return;
      const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(Buffer.concat(data));
      const frameType = isBinary ? TunnelFrameType.WsBinary : TunnelFrameType.WsText;
      if (pendingWsBytes + bytes.length > MAX_PENDING_WS_BYTES || pendingWsMessages >= MAX_PENDING_WS_MESSAGES) {
        abortLocalStream(streamId, 'upstream WebSocket exceeded downstream queue limit');
        void sendAbort(streamId, 'upstream WebSocket exceeded downstream queue limit');
        return;
      }
      pendingWsBytes += bytes.length;
      pendingWsMessages += 1;
      socketPendingMessages += 1;
      if (CAN_PAUSE_WS_READS) socket.pause();
      outputChain = outputChain.then(async () => {
        const chunks = chunkPayload(bytes, responseChunkBytes);
        const groupSize = Math.max(1, Math.floor(MAX_TUNNEL_PAYLOAD_BYTES / responseChunkBytes));
        for (let offset = 0; offset < chunks.length; offset += groupSize) {
          await waitForBackpressure(null);
          if (streams.get(streamId) !== stream || closed) return;
          await Promise.all(chunks.slice(offset, offset + groupSize).map((chunk, index) =>
            send(encodeTunnelFrame(frameType, streamId, chunk, offset + index < chunks.length - 1))));
        }
      }).catch(() => {
        abortLocalStream(streamId, 'upstream WebSocket forwarding failed');
        void sendAbort(streamId, 'upstream WebSocket forwarding failed');
      }).finally(() => {
        pendingWsBytes -= bytes.length;
        pendingWsMessages -= 1;
        socketPendingMessages -= 1;
        if (CAN_PAUSE_WS_READS && socketPendingMessages === 0 && streams.get(streamId) === stream && socket.readyState === WebSocket.OPEN) socket.resume();
      });
    });
    socket.on('close', (code, reasonBuffer) => {
      void outputChain.then(async () => {
        if (streams.get(streamId) !== stream) return;
        dropStream(streamId);
        const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
        if (stream.opened) {
          await sendJson(TunnelFrameType.WsClose, streamId, { code: code || 1000, reason });
        } else {
          await sendAbort(streamId, reason || `upstream ws closed (${code || 'no code'})`);
        }
      });
    });
    socket.on('error', (error) => {
      if (streams.get(streamId) !== stream) return;
      if (!stream.opened) {
        dropStream(streamId);
        try {
          socket.terminate();
        } catch {
          // already gone
        }
        void sendAbort(streamId, error?.message ?? 'upstream ws error');
      }
    });
  };

  const handleWsMessage = (streamId, frameType, message) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws' || stream.socket.readyState !== WebSocket.OPEN) return;
    if (frameType === TunnelFrameType.WsText) {
      stream.socket.send(Buffer.from(message).toString('utf8'));
    } else {
      stream.socket.send(message, { binary: true });
    }
  };

  const handleWsClose = (streamId, payload) => {
    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'ws') return;
    dropStream(streamId);
    cancelPendingFrames(streamId);
    let close = { code: 1000, reason: '' };
    try {
      close = decodeJsonPayload(payload, isWsClosePayload);
    } catch {
      // fall through with defaults
    }
    const code = Number.isInteger(close.code) && close.code >= 1000 && close.code <= 4999 ? close.code : 1000;
    try {
      if (CAN_PAUSE_WS_READS) stream.socket.resume();
      stream.socket.close(code, typeof close.reason === 'string' ? close.reason : '');
    } catch {
      stream.socket.terminate();
    }
  };


  /** @param {Uint8Array} plaintextFrame one decrypted tunnel frame */
  const handleFrame = async (plaintextFrame) => {
    if (closed) return;
    const frame = decodeTunnelFrame(plaintextFrame);

    if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
      const message = assembler.push(frame);
      if (message === null) return;
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
        handleWsOpen(frame.streamId, frame.payload);
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
        return;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const streamId of [...streams.keys()]) {
      abortLocalStream(streamId, 'connection closed');
    }
    streams.clear();
  };

  return {
    handleFrame,
    close,
    get streamCount() {
      return streams.size;
    },
  };
};
