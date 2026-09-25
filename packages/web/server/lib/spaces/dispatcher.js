// The dispatcher: a thin layer in front of the host's routes that forwards a request addressed
// to a space to the OpenChamber server inside that space, over the place's `connect` channel.
//
// The client addresses the space. A request goes to a space only when its path starts with
// `/api/spaces/<id>/` and the id is in the label-derived list of spaces. The dispatcher reads the
// path and nothing else to decide that: no directory, no body, no session id. It runs after the
// host has authenticated the user, strips the prefix and the user's credentials, adds the
// space's own session, and streams the rest untouched, HTTP and SSE alike. WebSocket upgrades
// under the prefix are forwarded by `websocket.js`, which shares the rules and the session
// of this module; the merged session list and the event connection of a space use
// `requestInside` for their own requests to the server inside.
//
// Two guards only reject. A prefixed request whose directory lies outside that space's root is
// refused, and an unprefixed request whose directory lies under `/spaces/` is refused before
// any host route sees it. Neither guard routes anything.
//
// Everything that comes back from a space is untrusted. A response cannot set a cookie on the
// app's origin, and nothing from a space renders as a page under it.

import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';

import { writeSseChunkWithBackpressure } from '../opencode/proxy.js';
import { SpaceError } from './errors.js';
import { isSpaceId } from './labels.js';
import { SPACE_SERVER_HOST, SPACE_SERVER_PORT, spaceWorkPath } from './layout.js';

const SPACE_ROUTE_PREFIX = '/api/spaces/';
const SPACES_ROOT = '/spaces';

// How long the label-derived list of spaces is trusted, and how soon a miss may read it again.
// The list is authoritative state read from the runtime; the cache only keeps a burst of
// requests from running `docker ps` for each of them.
const LIST_TTL_MS = 2_000;
const LIST_MISS_RETRY_MS = 500;

// The session inside is renewed before the cookie the server inside gave expires.
const SESSION_RENEW_FRACTION = 0.9;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 30_000;

// One `docker exec` per socket, so the agent keeps a few per space and reuses them. A free
// socket is closed after four seconds, before the server inside closes its side at five,
// Node's default keep-alive timeout, so a request never lands on a socket the server is closing.
const MAX_SOCKETS_PER_SPACE = 8;
const FREE_SOCKET_TIMEOUT_MS = 4_000;

// How much of an error's text from the transport an answer may carry.
const ERROR_TEXT_CHARACTERS = 300;

// Route families that exist on the host only, never in a space: provider and login pages,
// settings, GitHub, Linear, voice, guests, project routes, and the host's own system routes.
// A prefixed request for one of them is refused, whatever the server inside would answer.
const HOST_ONLY_ROUTES = Object.freeze([
  '/api/provider',
  '/api/providers',
  '/api/integration',
  '/api/credential',
  '/api/auth',
  '/api/config/settings',
  '/api/config/themes',
  '/api/themes',
  '/api/github',
  '/api/linear',
  '/api/voice',
  '/api/tts',
  '/api/dictation',
  '/api/guests',
  '/api/projects',
  '/api/client-auth',
  '/api/system',
  '/api/push',
  '/api/notifications',
  '/api/openchamber/tunnel',
]);

// Route families refused across the boundary: they would move something between the host and
// a space, or render a space's file as a page under the app's origin. Moving a session, the
// worktree and git-integrate actions, `/api/fs/serve` and `/api/preview/proxy`.
const REFUSED_ACROSS_BOUNDARY_ROUTES = Object.freeze([
  '/api/git/worktrees',
  '/api/git/worktree-type',
  '/api/git/integrate',
  '/api/fs/serve',
  '/api/preview/proxy',
]);
const SESSION_MOVE_ROUTE = /^\/api\/session\/[^/]+\/move(?:\/|$)/;

// Request headers that never travel into a space: the user's credentials, hop-by-hop headers,
// where the request came from, and the encoding, which is asked for again as identity.
const DROPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'origin',
  'referer',
  'accept-encoding',
  'proxy-connection',
]);
const DROPPED_REQUEST_HEADER_PREFIXES = ['x-forwarded-', 'forwarded', 'sec-websocket-'];

// The only response headers that come back from a space: what a client needs to read the body
// and cache it. An allowlist, because a header the space chooses can act on the app's origin:
// `Set-Cookie` sets a cookie there, `Location` sends the user's next request, credentials and
// body included, to a host route the agent names, `Clear-Site-Data` wipes the app's storage.
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'pragma',
  'etag',
  'last-modified',
  'vary',
  'date',
  'x-accel-buffering',
  'x-next-cursor',
]);

// Query parameters that carry the user's credentials on browser-owned URLs.
const DROPPED_QUERY_PARAMETERS = ['oc_url_token', 'oc_client_token'];

// Content types a browser would render as a page, with the space's script in it, under the
// app's origin. A response from a space with one of these is served as plain text instead.
const PAGE_CONTENT_TYPES = /^\s*(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/pdf)\b/i;
// What `/api/fs/raw` from a space may be served as: an image a browser only draws, or a download.
const RAW_FILE_CONTENT_TYPES = /^\s*(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)\s*(?:;|$)/i;
const RAW_FILE_ROUTE = '/api/fs/raw';
const isRawFileRoute = (pathname) => pathname.toLowerCase() === RAW_FILE_ROUTE;

/** `/api/spaces/<id>/<rest>` as `{ spaceId, path }` with `path` being `/api/<rest>` inside, or null. */
export function parseSpaceRoute(pathname) {
  if (!pathname.startsWith(SPACE_ROUTE_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(SPACE_ROUTE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  return { spaceId: rest.slice(0, slash), path: `/api${rest.slice(slash)}` };
}

/** Whether a request path is one the dispatcher owns. Body parsers leave such a request alone. */
export const isSpaceRequestPath = (pathname) => parseSpaceRoute(pathname) !== null;

// A directory as a client wrote it, normalised the way a POSIX path is, with no `..` left in it.
const normalizeDirectory = (value) => {
  if (value.trim() === '') return null;
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const isUnder = (directory, root) => directory === root || directory.startsWith(`${root}/`);

/** Whether a directory lies under `/spaces/`, where only a space's own paths live. */
export const isSpaceDirectory = (value) => {
  const directory = normalizeDirectory(value);
  return directory !== null && isUnder(directory, SPACES_ROOT);
};

/** Whether a directory lies inside this space's root, `/spaces/<id>`. */
export const isDirectoryOfSpace = (value, spaceId) => {
  const directory = normalizeDirectory(value);
  return directory !== null && isUnder(directory, spaceWorkPath(spaceId));
};

const matchesRoute = (pathname, route) => pathname === route || pathname.startsWith(`${route}/`);

/** The rule a path inside a space falls under: `host_only`, `refused_across_boundary` or null. */
export function classifySpacePath(pathname) {
  // Express inside routes without regard to case, so the rules read the path the same way.
  const lower = pathname.toLowerCase();
  if (HOST_ONLY_ROUTES.some((route) => matchesRoute(lower, route))) return 'host_only';
  if (REFUSED_ACROSS_BOUNDARY_ROUTES.some((route) => matchesRoute(lower, route)) || SESSION_MOVE_ROUTE.test(lower)) {
    return 'refused_across_boundary';
  }
  return null;
}

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// A percent-escape in the header: the SDK sends the directory URI-encoded on every request,
// with no marker, and OpenCode decodes it on its side, so the guards must read what OpenCode
// will. The marker still says so for the values the UI encodes because they are not Latin-1.
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

/** Every directory a request names in its query or its directory header, as OpenCode reads them. */
export function requestedDirectories(req, url) {
  const directories = [];
  for (const key of ['directory', 'location[directory]']) {
    for (const value of url.searchParams.getAll(key)) directories.push(value);
  }
  const header = req.headers['x-opencode-directory'];
  if (header !== undefined && header.length > 0) {
    const encoded = req.headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(header);
    directories.push(encoded ? safeDecode(header) : header);
  }
  return directories;
}

const shortText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_CHARACTERS);

const answer = (res, status, code, message) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: message, code });
};

/** The status and code an error of the transport or of a place gets on the way back to the client. */
export const describeFailure = (error) => {
  const code = error instanceof SpaceError ? error.code : null;
  switch (code) {
    case 'space_not_found':
    case 'space_not_ours':
    case 'invalid_space_id':
      return { status: 404, code: 'space_not_found', message: 'There is no such space.' };
    case 'space_not_running':
    case 'space_move_unfinished':
      return { status: 503, code, message: shortText(error.message) };
    case 'space_token_unreadable':
    case 'space_setup_failed':
    case 'space_login_failed':
      return { status: 502, code, message: shortText(error.message) };
    case 'space_request_body_consumed':
      return { status: 500, code, message: shortText(error.message) };
    case 'space_redirected':
      return { status: 502, code, message: shortText(error.message) };
    default:
      return { status: 502, code: 'space_unreachable', message: `The server inside the space could not be reached: ${shortText(error?.message ?? error)}` };
  }
};

const parseSetCookie = (header) => {
  const line = header?.[0] ?? '';
  if (line.length === 0) return null;
  const [pair, ...attributes] = line.split(';');
  const equals = pair.indexOf('=');
  if (equals <= 0) return null;
  let ttlMs = DEFAULT_SESSION_TTL_MS;
  for (const attribute of attributes) {
    const [name, value] = attribute.trim().split('=');
    if (name.toLowerCase() === 'max-age' && /^\d+$/.test(value ?? '')) ttlMs = Number(value) * 1000;
  }
  return { cookie: pair.trim(), ttlMs };
};

const hasBody = (req) => 'content-length' in req.headers || 'transfer-encoding' in req.headers;

/**
 * The headers a request carries into a space: the client's, without the user's credentials and
 * the hop-by-hop ones, plus the space's session, the loopback host and identity encoding.
 */
export const forwardRequestHeaders = (requestHeaders, cookie) => {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || DROPPED_REQUEST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (value !== undefined) headers[lower] = value;
  }
  headers.host = `${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`;
  headers.cookie = cookie;
  headers['accept-encoding'] = 'identity';
  return headers;
};

/** Takes the user's URL credentials off a query before it travels. */
export const stripCredentialQuery = (url) => {
  for (const parameter of DROPPED_QUERY_PARAMETERS) url.searchParams.delete(parameter);
};

/**
 * `transport` is `{ listSpaceIds(), connect(spaceId), readToken(spaceId) }`: the ids from the
 * runtime's labels, the place's `connect`, and the token read back over `exec`. `now` and
 * `logger` are injectable for the tests.
 */
export function createSpaceDispatcher({ transport, now = Date.now, logger = console }) {
  const agents = new Map();
  const tokens = new Map();
  const sessions = new Map();
  const logins = new Map();
  let known = { ids: new Set(), readAt: -Infinity };
  let listing = null;

  const readSpaceIds = async () => {
    if (!listing) {
      listing = transport.listSpaceIds()
        .then((ids) => { known = { ids: new Set(ids), readAt: now() }; })
        .finally(() => { listing = null; });
    }
    await listing;
  };

  /** Whether the runtime's labels name this space, read again when the answer is stale or a miss. */
  const isKnownSpace = async (spaceId) => {
    const age = now() - known.readAt;
    if (age >= LIST_TTL_MS || (!known.ids.has(spaceId) && age >= LIST_MISS_RETRY_MS)) {
      await readSpaceIds();
    }
    return known.ids.has(spaceId);
  };

  const agentFor = (spaceId) => {
    let agent = agents.get(spaceId);
    if (!agent) {
      agent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS_PER_SPACE, timeout: FREE_SOCKET_TIMEOUT_MS });
      agent.createConnection = (_options, callback) => {
        transport.connect(spaceId).then((stream) => callback(null, stream), (error) => callback(error));
      };
      agents.set(spaceId, agent);
    }
    return agent;
  };

  const tokenFor = async (spaceId, fresh) => {
    if (!fresh && tokens.has(spaceId)) return tokens.get(spaceId);
    const token = await transport.readToken(spaceId);
    tokens.set(spaceId, token);
    return token;
  };

  /** One small request to the server inside, buffered, for the login. */
  const sendInside = (spaceId, { method, path: requestPath, headers, body }) => new Promise((resolve, reject) => {
    const request = http.request({
      agent: agentFor(spaceId),
      method,
      path: requestPath,
      timeout: LOGIN_TIMEOUT_MS,
      headers: { ...headers, host: `${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`, 'accept-encoding': 'identity', 'content-length': String(Buffer.byteLength(body)) },
    }, (response) => {
      // Only the status and the cookie matter; the body is drained and dropped.
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new SpaceError('space_login_failed', 'The server inside the space did not answer the login in time')));
    request.on('error', reject);
    request.end(body);
  });

  /** Logs in to the server inside with the space's token, once per space at a time. */
  /** One login attempt with the token as it is remembered or freshly read. Null when refused. */
  const attemptLogin = async (spaceId, fresh) => {
    const token = await tokenFor(spaceId, fresh);
    const response = await sendInside(spaceId, {
      method: 'POST',
      path: '/auth/session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: token }),
    });
    const session = response.status === 200 ? parseSetCookie(response.headers['set-cookie']) : null;
    return session ? { session, status: response.status } : { session: null, status: response.status };
  };

  const logIn = (spaceId, { fresh }) => {
    if (logins.has(spaceId)) return logins.get(spaceId);
    const login = (async () => {
      let attempt = await attemptLogin(spaceId, fresh);
      if (!attempt.session && !fresh) {
        // The remembered token may be stale: the agent can rewrite the file and the server inside
        // can restart on the new one. One more read, one more login, and no more.
        tokens.delete(spaceId);
        attempt = await attemptLogin(spaceId, true);
      }
      if (!attempt.session) {
        throw new SpaceError('space_login_failed', `The server inside the space did not accept the space's token (status ${attempt.status})`);
      }
      sessions.set(spaceId, { cookie: attempt.session.cookie, renewAt: now() + attempt.session.ttlMs * SESSION_RENEW_FRACTION });
      return attempt.session.cookie;
    })().finally(() => logins.delete(spaceId));
    logins.set(spaceId, login);
    return login;
  };

  const sessionFor = async (spaceId) => {
    const session = sessions.get(spaceId);
    if (session && now() < session.renewAt) return session.cookie;
    // The token is read again only when a login with the remembered one was refused.
    return logIn(spaceId, { fresh: false });
  };

  const forgetSession = (spaceId) => { sessions.delete(spaceId); };

  /**
   * One request of the host's own to the server inside, for the session list and the event
   * connection: the space must be known, the session is renewed once after a 401, and a request
   * that met a dead pooled stream is sent once more. Resolves the response with its body still
   * to be read; the caller ends or destroys it. Rejects with the place's or the transport's code.
   */
  const requestInside = async (spaceId, { method = 'GET', path: requestPath, headers = {}, timeoutMs = 0 }) => {
    if (!await isKnownSpace(spaceId)) throw new SpaceError('space_not_found', `There is no space ${spaceId}`);
    const once = (cookie) => new Promise((resolve, reject) => {
      const request = http.request({
        agent: agentFor(spaceId),
        method,
        path: requestPath,
        headers: { ...headers, host: `${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`, cookie, 'accept-encoding': 'identity' },
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      });
      request.on('timeout', () => request.destroy(new SpaceError('space_unreachable', 'The server inside the space did not answer in time')));
      request.on('response', resolve);
      request.on('error', reject);
      request.end();
    });
    let response;
    try {
      response = await once(await sessionFor(spaceId));
    } catch (error) {
      if (error?.code !== 'command_stream_failed') throw error;
      response = await once(await sessionFor(spaceId));
    }
    if (response.statusCode !== 401) return response;
    response.resume();
    forgetSession(spaceId);
    const renewed = await logIn(spaceId, { fresh: true });
    const again = await once(renewed);
    if (again.statusCode === 401) {
      again.resume();
      throw new SpaceError('space_login_failed', 'The server inside the space refused a session it had just issued');
    }
    return again;
  };

  /** Copies a response from inside onto the client's, with the origin rules applied. */
  const applyResponseHeaders = (upstream, res, innerPath) => {
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (!FORWARDED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
      res.setHeader(name, value);
    }
    res.setHeader('x-content-type-options', 'nosniff');
    const contentType = String(upstream.headers['content-type'] ?? '');
    if (isRawFileRoute(innerPath)) {
      if (!RAW_FILE_CONTENT_TYPES.test(contentType)) {
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', 'attachment');
      }
    } else if (contentType === '' || PAGE_CONTENT_TYPES.test(contentType)) {
      // A missing type is what a browser sniffs on a navigation; `nosniff` does not stop that.
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
  };

  const isEventStream = (upstream) => String(upstream.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');

  /** Streams an event stream with backpressure, the way the host's own proxy does. */
  const pipeEventStream = (upstream, res) => {
    const abort = new AbortController();
    let queue = Promise.resolve(true);
    const enqueue = (chunk) => {
      queue = queue.catch(() => false).then((canContinue) => (canContinue ? writeSseChunkWithBackpressure(res, chunk, abort.signal) : false));
      return queue;
    };
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);
    const stop = () => {
      abort.abort();
      upstream.destroy();
    };
    res.on('close', stop);
    upstream.on('data', (chunk) => {
      enqueue(chunk).then((canContinue) => { if (!canContinue) stop(); });
    });
    upstream.on('end', () => { queue.then(() => { if (!res.writableEnded) res.end(); }); });
    upstream.on('error', () => { queue.then(() => { if (!res.writableEnded) res.end(); }); });
  };

  /**
   * Forwards one request to the space, once with the current session. Resolves `'done'` when
   * an answer went to the client, or `'unauthorized'` when the server inside refused the
   * session and `onUnauthorized` was `'report'`, with nothing sent to the client yet.
   */
  const forwardOnce = (req, res, { spaceId, innerPath, search, cookie, onUnauthorized }) => new Promise((resolve, reject) => {
    // A body that a parser on the host already read cannot be streamed again. That is a wiring
    // fault, and it answers as one rather than waiting for bytes that never come.
    if (hasBody(req) && req.readableEnded) {
      reject(new SpaceError('space_request_body_consumed', 'The body of this request was read on the host before the dispatcher saw it'));
      return;
    }
    const upstreamRequest = http.request({
      agent: agentFor(spaceId),
      method: req.method,
      path: `${innerPath}${search}`,
      headers: forwardRequestHeaders(req.headers, cookie),
    });
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const finish = settle(resolve);
    const fail = settle(reject);
    // A client that leaves before its answer is complete takes the request inside with it. After
    // a complete answer the socket is back in the agent's pool, and nothing is destroyed.
    const onClientGone = () => { if (!res.writableFinished) upstreamRequest.destroy(); };
    res.on('close', onClientGone);

    upstreamRequest.on('response', (upstream) => {
      if (upstream.statusCode === 401 && onUnauthorized === 'report') {
        upstream.resume();
        upstream.on('end', () => finish('unauthorized'));
        upstream.on('error', () => finish('unauthorized'));
        return;
      }
      // A 304 answers a browser's own revalidation of a body it holds: no location, no body,
      // nothing to follow, and the sidebar's list requests carry an ETag on every reload.
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.statusCode !== 304) {
        // A redirect from a space would send the user's next request wherever the agent says.
        upstream.resume();
        fail(new SpaceError('space_redirected', 'The server inside the space answered with a redirect, which is not followed'));
        return;
      }
      res.status(upstream.statusCode);
      applyResponseHeaders(upstream, res, innerPath);
      if (isEventStream(upstream)) {
        pipeEventStream(upstream, res);
        finish('done');
        return;
      }
      pipeline(upstream, res, () => {});
      finish('done');
    });
    upstreamRequest.on('error', (error) => {
      if (res.destroyed) {
        finish('done');
        return;
      }
      fail(error);
    });
    if (hasBody(req)) {
      // Not `pipeline`: an error inside would destroy the client's request, and with it the
      // connection the answer has to go on. The body flows; the client leaving ends the request inside.
      req.pipe(upstreamRequest);
      req.on('error', () => upstreamRequest.destroy());
    } else {
      upstreamRequest.end();
    }
  });

  const forward = async (req, res, spaceId, innerPath, search) => {
    if (!await isKnownSpace(spaceId)) {
      answer(res, 404, 'space_not_found', 'There is no such space.');
      return;
    }
    let cookie;
    try {
      cookie = await sessionFor(spaceId);
    } catch (error) {
      const failure = describeFailure(error);
      logger.warn?.(`[spaces] login to space ${spaceId} failed: ${failure.code}`);
      answer(res, failure.status, failure.code, failure.message);
      return;
    }
    try {
      let outcome;
      try {
        outcome = await forwardOnce(req, res, { spaceId, innerPath, search, cookie, onUnauthorized: 'report' });
      } catch (error) {
        // A stream from the agent's pool can die between two requests: the server inside closed
        // it, or the space stopped. A request without a body is sent once more on a fresh stream,
        // which the place opens or refuses with its own code; a request with a body cannot be.
        if (error?.code !== 'command_stream_failed' || hasBody(req) || res.headersSent) throw error;
        outcome = await forwardOnce(req, res, { spaceId, innerPath, search, cookie, onUnauthorized: 'report' });
      }
      if (outcome !== 'unauthorized') return;
      // The server inside refused the session. The remembered token may be stale as well, when
      // the space was made again, so the login reads it once more.
      forgetSession(spaceId);
      const renewed = await logIn(spaceId, { fresh: true });
      if (hasBody(req)) {
        // The body went with the first attempt and cannot be sent again. The session is renewed
        // now, so the next request goes through; this one says why it did not.
        answer(res, 503, 'space_session_expired', 'The session with the server inside the space had expired and was renewed. Send the request again.');
        return;
      }
      const again = await forwardOnce(req, res, { spaceId, innerPath, search, cookie: renewed, onUnauthorized: 'report' });
      if (again === 'unauthorized') {
        throw new SpaceError('space_login_failed', 'The server inside the space refused a session it had just issued');
      }
    } catch (error) {
      const failure = describeFailure(error);
      logger.warn?.(`[spaces] request to space ${spaceId} failed: ${failure.code}`);
      answer(res, failure.status, failure.code, failure.message);
    }
  };

  /**
   * The Express middleware. Mount it after the host has authenticated the request and before
   * every route that reads a directory: it dispatches prefixed requests and guards the rest.
   */
  const middleware = (req, res, next) => {
    const url = new URL(req.originalUrl ?? req.url, 'http://localhost');
    const route = parseSpaceRoute(url.pathname);
    if (!route) {
      // Guard two. A space's directory never runs on the host, whatever fallback would follow.
      if (url.pathname.startsWith('/api/') && requestedDirectories(req, url).some(isSpaceDirectory)) {
        answer(res, 400, 'space_directory_needs_prefix', 'A directory under /spaces/ belongs to an isolated space and is addressed as /api/spaces/<id>/... only.');
        return;
      }
      next();
      return;
    }
    if (!isSpaceId(route.spaceId)) {
      answer(res, 404, 'space_not_found', 'There is no such space.');
      return;
    }
    const rule = classifySpacePath(route.path);
    if (rule === 'host_only') {
      answer(res, 403, 'host_only_route', 'This route exists on the host only and is not forwarded to a space.');
      return;
    }
    if (rule === 'refused_across_boundary') {
      answer(res, 403, 'refused_across_boundary', 'This action does not cross the boundary of an isolated space.');
      return;
    }
    // Guard one. A prefixed request names this space's directories or none.
    if (requestedDirectories(req, url).some((directory) => !isDirectoryOfSpace(directory, route.spaceId))) {
      answer(res, 400, 'directory_outside_space', `A request to space ${route.spaceId} may name a directory under ${spaceWorkPath(route.spaceId)} only.`);
      return;
    }
    stripCredentialQuery(url);
    forward(req, res, route.spaceId, route.path, url.search).catch((error) => {
      const failure = describeFailure(error);
      answer(res, failure.status, failure.code, failure.message);
    });
  };

  /** Ends every connection into every space. */
  const close = () => {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
    sessions.clear();
    tokens.clear();
  };

  /** What the WebSocket forwarder shares with the middleware: the list of spaces and the session inside. */
  const spaceSessions = {
    isKnownSpace,
    cookieFor: sessionFor,
    renew: (spaceId) => {
      forgetSession(spaceId);
      return logIn(spaceId, { fresh: true });
    },
  };

  return { middleware, close, isSpaceDirectory, isSpaceRequestPath, requestInside, spaceSessions };
}
