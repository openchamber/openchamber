
import { SpaceError } from './errors.js';
import { isSpaceId } from './labels.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';
import { SPACE_SERVER_HOST, SPACE_SERVER_PORT, spaceWorkPath } from './layout.js';
import {
  classifySpacePath,
  describeFailure,
  forwardRequestHeaders,
  isDirectoryOfSpace,
  requestedDirectories,
  spaceRouteOf,
  stripCredentialQuery,
} from './dispatcher.js';

const SPACE_WEBSOCKET_PATHS = Object.freeze(['/api/terminal/ws', '/api/dev-tunnel', '/api/event/ws', '/api/global/event/ws']);
const DEV_TUNNEL_PATH = '/api/dev-tunnel';

const HANDSHAKE_REQUEST_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];
const HANDSHAKE_RESPONSE_HEADERS = new Set(['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']);

const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_SOCKETS_PER_SPACE = 72;
const CLOSE_REASON_BYTES = 123;
const CLOSE_GRACE_MS = 1_000;

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

const refuse = (socket, status, code, message) => {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify({ error: message, code }), 'utf8');
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`);
    socket.end(body);
  } catch {
    socket.destroy();
  }
};

// external: https://www.rfc-editor.org/rfc/rfc6455#section-5.1 Server WebSocket frames are unmasked.
export const closeFrame = (code, reason) => {
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, CLOSE_REASON_BYTES);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
};

const headerValue = (value) => (Array.isArray(value) ? value.join(', ') : value);

export const buildHandshake = ({ innerPath, search, requestHeaders, cookie }) => {
  const headers = forwardRequestHeaders(requestHeaders, cookie);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  headers.origin = `http://${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`;
  for (const name of HANDSHAKE_REQUEST_HEADERS) {
    const value = headerValue(requestHeaders[name]);
    if (value !== undefined) headers[name] = value;
  }
  const lines = [`GET ${innerPath}${search} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new SpaceError('invalid_request', `The header ${name} holds a line break`);
    lines.push(`${name}: ${text}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

export const parseHandshakeAnswer = (buffer) => {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const [statusLine, ...headerLines] = buffer.subarray(0, end).toString('utf8').split('\r\n');
  const status = Number.parseInt(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? '', 10);
  if (Number.isNaN(status)) throw new SpaceError('space_unreachable', 'The server inside the space answered the upgrade with something that is not HTTP');
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, rest: buffer.subarray(end + 4) };
};

export function createSpaceWebSocketForwarder({ dispatcher, connect, uiAuthController, isRequestOriginAllowed, logger = console, maxSocketsPerSpace = MAX_SOCKETS_PER_SPACE }) {
  const open = new Map();

  const count = (spaceId) => open.get(spaceId)?.size ?? 0;
  const track = (spaceId, pair) => {
    if (!open.has(spaceId)) open.set(spaceId, new Set());
    open.get(spaceId).add(pair);
  };
  const untrack = (spaceId, pair) => {
    open.get(spaceId)?.delete(pair);
    if (count(spaceId) === 0) open.delete(spaceId);
  };

  const authorize = async (req, innerPath) => {
    if (isOpaqueOriginRequest(req)) return { status: 403, code: 'invalid_origin', message: 'Invalid origin' };
    if (!uiAuthController?.enabled) {
      return await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)
        ? null
        : { status: 403, code: 'invalid_origin', message: 'Invalid origin' };
    }
    if (innerPath === DEV_TUNNEL_PATH) {
      const auth = await uiAuthController.resolveAuthContext(req, null, { allowUrlToken: true });
      if (!auth) return { status: 401, code: 'unauthorized', message: 'UI authentication required' };
      const hasOrigin = String(req.headers.origin ?? '').trim() !== '';
      if (hasOrigin && !await isRequestOriginAllowed(req)) return { status: 403, code: 'invalid_origin', message: 'Invalid origin' };
      if (!hasOrigin && auth.type !== 'client') return { status: 403, code: 'client_auth_required', message: 'Client authentication required' };
      return null;
    }
    if (!await uiAuthController.ensureSessionToken(req, null)) return { status: 401, code: 'unauthorized', message: 'UI authentication required' };
    if (!await isRequestOriginAllowed(req)) return { status: 403, code: 'invalid_origin', message: 'Invalid origin' };
    return null;
  };

  const handshake = (spaceId, request, signal) => new Promise((resolve, reject) => {
    let stream;
    let settled = false;
    const chunks = [];
    let received = 0;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      stream?.destroy();
      reject(error);
    };
    const onAbort = () => fail(new SpaceError('client_gone', 'The client left before the upgrade was answered'));
    const timer = setTimeout(() => fail(new SpaceError('space_unreachable', 'The server inside the space did not answer the upgrade in time')), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    connect(spaceId).then((opened) => {
      if (settled) { opened.destroy(); return; }
      stream = opened;
      stream.on('error', (error) => fail(error));
      stream.on('end', () => fail(new SpaceError('space_unreachable', 'The server inside the space closed the upgrade')));
      const onData = (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        let answer;
        try {
          answer = parseHandshakeAnswer(Buffer.concat(chunks));
        } catch (error) {
          fail(error);
          return;
        }
        if (!answer) {
          if (received > MAX_HANDSHAKE_BYTES) fail(new SpaceError('space_unreachable', 'The server inside the space sent too many bytes before its upgrade answer'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        stream.removeListener('data', onData);
        stream.removeAllListeners('end');
        stream.pause();
        resolve({ stream, answer });
      };
      stream.on('data', onData);
      stream.write(request);
    }, fail);
  });

  const join = ({ spaceId, socket, head, stream, answer, pair }) => {
    pair.stream = stream;
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [name, value] of Object.entries(answer.headers)) {
      if (HANDSHAKE_RESPONSE_HEADERS.has(name)) lines.push(`${name}: ${value}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (answer.rest.length > 0) socket.write(answer.rest);
    if (head.length > 0) stream.write(head);
    socket.setNoDelay?.(true);
    let ended = false;
    const endWith = (code, reason) => {
      if (ended) return;
      ended = true;
      if (!socket.destroyed) {
        try { socket.end(closeFrame(code, reason)); } catch { socket.destroy(); }
        setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref?.();
      }
      stream.destroy();
    };
    socket.on('close', () => untrack(spaceId, pair));
    stream.on('error', () => endWith(1011, 'space_unreachable'));
    stream.on('end', () => endWith(1012, 'space_closed'));
    stream.on('close', () => endWith(1012, 'space_closed'));
    socket.on('error', () => endWith(1011, 'client_gone'));
    socket.on('end', () => endWith(1011, 'client_gone'));
    socket.on('close', () => endWith(1011, 'client_gone'));
    stream.pipe(socket, { end: false });
    socket.pipe(stream, { end: false });
    stream.resume();
  };

  const forward = async (req, socket, head, route, search) => {
    if (!await dispatcher.spaceSessions.isKnownSpace(route.spaceId)) {
      refuse(socket, 404, 'space_not_found', 'There is no such space.');
      return;
    }
    if (count(route.spaceId) >= maxSocketsPerSpace) {
      refuse(socket, 503, 'space_socket_limit', `Space ${route.spaceId} has too many open sockets.`);
      return;
    }
    const pair = { socket, stream: null };
    track(route.spaceId, pair);
    const gone = new AbortController();
    const onLeave = () => gone.abort();
    const early = [];
    const onEarly = (chunk) => early.push(chunk);
    socket.on('data', onEarly);
    socket.on('end', onLeave);
    socket.on('close', onLeave);
    try {
      const attempt = async (cookie) => handshake(route.spaceId, buildHandshake({ innerPath: route.path, search, requestHeaders: req.headers, cookie }), gone.signal);
      let result = await attempt(await dispatcher.spaceSessions.cookieFor(route.spaceId));
      if (result.answer.status === 401) {
        result.stream.destroy();
        result = await attempt(await dispatcher.spaceSessions.renew(route.spaceId));
      }
      if (result.answer.status !== 101) {
        result.stream.destroy();
        const status = result.answer.status >= 400 && result.answer.status < 600 ? result.answer.status : 502;
        throw new SpaceError('space_socket_refused', `The server inside the space refused the socket with status ${result.answer.status}.`, { status });
      }
      socket.removeListener('data', onEarly);
      socket.removeListener('end', onLeave);
      socket.removeListener('close', onLeave);
      join({ spaceId: route.spaceId, socket, head: Buffer.concat([head, ...early]), stream: result.stream, answer: result.answer, pair });
    } catch (error) {
      socket.removeListener('data', onEarly);
      socket.removeListener('end', onLeave);
      socket.removeListener('close', onLeave);
      untrack(route.spaceId, pair);
      throw error;
    }
  };

  const upgradeHandler = (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = spaceRouteOf(req, url);
    if (!route) return;
    if (!url.pathname.toLowerCase().startsWith('/api/spaces/')) {
      req.url = `/api/spaces/${encodeURIComponent(route.spaceId)}${url.pathname.slice('/api'.length)}${url.search}`;
    }
    socket.on('error', () => {});
    if (!isSpaceId(route.spaceId)) { refuse(socket, 404, 'space_not_found', 'There is no such space.'); return; }
    const rule = classifySpacePath(route.path);
    if (rule === 'host_only') { refuse(socket, 403, 'host_only_route', 'This route exists on the host only and is not forwarded to a space.'); return; }
    if (rule === 'refused_across_boundary') { refuse(socket, 403, 'refused_across_boundary', 'This action does not cross the boundary of an isolated space.'); return; }
    const innerPath = route.path.toLowerCase();
    if (!SPACE_WEBSOCKET_PATHS.includes(innerPath)) { refuse(socket, 404, 'space_socket_unknown', 'No socket of a space answers at this path.'); return; }
    void (async () => {
      try {
        const denied = await authorize(req, innerPath);
        if (denied) { refuse(socket, denied.status, denied.code, denied.message); return; }
        if (requestedDirectories(req, url).some((directory) => !isDirectoryOfSpace(directory, route.spaceId))) {
          refuse(socket, 400, 'directory_outside_space', `A request to space ${route.spaceId} may name a directory under ${spaceWorkPath(route.spaceId)} only.`);
          return;
        }
        stripCredentialQuery(url);
        await forward(req, socket, head, { spaceId: route.spaceId, path: innerPath }, url.search);
      } catch (error) {
        if (error?.code === 'client_gone') { socket.destroy(); return; }
        if (error?.code === 'space_socket_refused') {
          refuse(socket, error.details.status, error.code, error.message);
          return;
        }
        const failure = describeFailure(error);
        logger.warn?.(`[spaces] socket to space ${route.spaceId} failed: ${failure.code}`);
        refuse(socket, failure.status, failure.code, failure.message);
      }
    })();
  };

  const close = () => {
    for (const pairs of open.values()) {
      for (const pair of pairs) {
        pair.stream?.destroy();
        pair.socket.destroy();
      }
    }
    open.clear();
  };

  return { upgradeHandler, close, openSocketCount: (spaceId) => count(spaceId) };
}
