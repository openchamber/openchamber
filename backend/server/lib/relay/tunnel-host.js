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
 * }} deps
 */
export const createTunnelHost = ({ connectionId, getLocalPort, sendFrame, getBufferedAmount }) => {
  /** @type {Map<number, { kind: 'http', abort: AbortController, body: ReadableStreamDefaultController | null } | { kind: 'ws', socket: WebSocket, opened: boolean }>} */
  const streams = new Map();
  const assembler = createFragmentAssembler();
  let closed = false;

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

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const buildRequestHeaders = (rawHeaders) => {
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
      headers[lower] = value;
    }
    headers['x-openchamber-relay-connection'] = connectionId;
    return headers;
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
    const method = request.method.toUpperCase();
    if (!isAllowedHttpPath(request.path)) {
      dropStream(streamId);
      await syntheticResponse(streamId, 403, 'Path is not allowed through the relay');
      return;
    }

    const stream = streams.get(streamId);
    if (!stream || stream.kind !== 'http') return;

    const hasBody = method !== 'GET' && method !== 'HEAD';
    let requestBody;
    if (hasBody) {
      requestBody = new ReadableStream({
        start(controller) {
          stream.body = controller;
        },
      });
    } else {
      stream.body = null;
      stream.noBody = true;
    }

    const url = `http://127.0.0.1:${getLocalPort()}${request.path}${request.query ? `?${request.query}` : ''}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: buildRequestHeaders(request.headers),
        body: requestBody,
        duplex: hasBody ? 'half' : undefined,
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
    await sendJson(TunnelFrameType.HttpResponse, streamId, { status: response.status, headers: responseHeaders });

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
    // The body controller attaches synchronously in runHttpStream before any
    // await, so by the time body frames arrive it is set for body-carrying
    // methods; drop stray body bytes otherwise.
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
    // Response side keeps running; only the request body is half-closed.
  };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

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
    if (!ALLOWED_WS_PATHS.has(open.path)) {
      void sendAbort(streamId, 'Path is not allowed through the relay');
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
      'x-openchamber-relay-connection': connectionId,
      origin: `http://127.0.0.1:${getLocalPort()}`,
    };
    let socket;
    try {
      socket = new WebSocket(url, open.protocols, {
        headers: dialHeaders,
      });
    } catch (error) {
      void sendAbort(streamId, error?.message ?? 'ws dial failed');
      return;
    }
    const stream = { kind: 'ws', socket, opened: false };
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
      void (async () => {
        for (const frame of encodeFragmentedMessage(frameType, streamId, bytes)) {
          await waitForBackpressure(null);
          if (streams.get(streamId) !== stream || closed) return;
          await send(frame);
        }
      })();
    });
    socket.on('close', (code, reasonBuffer) => {
      if (streams.get(streamId) !== stream) return;
      dropStream(streamId);
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
        dropStream(streamId);
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
        // Host never receives HttpResponse/WsOpened; ignore rather than tear down.
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
