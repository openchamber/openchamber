
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';

import { writeSseChunkWithBackpressure } from '../opencode/proxy.js';
import type { Request, RequestHandler, Response } from '../shared/http-contracts.js';
import { SpaceError, spaceErrorProperty } from './errors.js';
import { isSpaceId } from './labels.js';
import { SPACE_SERVER_HOST, SPACE_SERVER_PORT, spaceWorkPath } from './layout.js';

export interface SpaceDispatcherTransport {
  listSpaceIds(): Promise<{ ids: unknown[]; failure: unknown }>;
  connect(spaceId: string): Promise<Duplex>;
  readToken(spaceId: string): Promise<string>;
}

export interface SpaceDispatcherOptions {
  transport: SpaceDispatcherTransport;
  now?: (() => number) | undefined;
  logger?: { warn?: (message: string) => void };
  freeSocketTimeoutMs?: number | undefined;
}

export interface InsideRequest {
  method?: string;
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer | null;
  timeoutMs?: number;
}

type DirectoryValue = string | string[];
type RouteRequest = Pick<IncomingMessage, 'headers' | 'url'> & { originalUrl?: string };

export interface SpaceRoute {
  spaceId: string;
  path: string;
}

export interface SpaceFailure {
  status: number;
  code: string;
  message: string;
}

interface Session {
  cookie: string;
  renewAt: number;
}

export interface InsideResponse extends IncomingMessage {
  statusCode: number;
}

interface KnownSpaces {
  ids: Set<unknown>;
  failure: unknown;
  readAt: number;
}

interface ForwardRequest {
  spaceId: string;
  innerPath: string;
  search: string;
  cookie: string;
  onUnauthorized: 'report';
}

type ForwardOutcome = 'done' | 'unauthorized';
type SpaceConnectionCallback = (...result: [error: unknown] | [error: null, stream: Duplex]) => void;

const SPACE_ROUTE_PREFIX = '/api/spaces/';
const SPACES_ROOT = '/spaces';

const LIST_TTL_MS = 2_000;
const LIST_MISS_RETRY_MS = 500;

const SESSION_RENEW_FRACTION = 0.9;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 30_000;

const MAX_SOCKETS_PER_SPACE = 8;
const FREE_SOCKET_TIMEOUT_MS = 4_000;

const ERROR_TEXT_CHARACTERS = 300;

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
  '/api/tracker',
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

const REFUSED_ACROSS_BOUNDARY_ROUTES = Object.freeze([
  '/api/git/worktrees',
  '/api/git/worktree-type',
  '/api/git/integrate',
  '/api/git/project-worktrees',
  '/api/fs/preview',
  '/api/fs/serve',
  '/api/preview/proxy',
]);
const SESSION_MOVE_ROUTE = /^\/api\/session\/[^/]+\/move(?:\/|$)/;

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

const DROPPED_QUERY_PARAMETERS = ['oc_url_token', 'oc_client_token'];

const PAGE_CONTENT_TYPES = /^\s*(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/pdf)\b/i;
const RAW_FILE_CONTENT_TYPES = /^\s*(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)\s*(?:;|$)/i;
const RAW_FILE_ROUTE = '/api/fs/raw';
const isRawFileRoute = (pathname: string) => pathname.toLowerCase() === RAW_FILE_ROUTE;

export function parseSpaceRoute(pathname: string): SpaceRoute | null {
  if (!pathname.toLowerCase().startsWith(SPACE_ROUTE_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(SPACE_ROUTE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  return { spaceId: rest.slice(0, slash), path: `/api${rest.slice(slash)}` };
}

const normalizeDirectory = (value: DirectoryValue) => {
  if (Array.isArray(value)) throw new TypeError('value.trim is not a function');
  if (value.trim() === '') return null;
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const isUnder = (directory: string, root: string) => directory === root || directory.startsWith(`${root}/`);

export const isSpaceDirectory = (value: DirectoryValue) => {
  const directory = normalizeDirectory(value);
  return directory !== null && isUnder(directory, SPACES_ROOT);
};

const spaceIdOfDirectory = (value: DirectoryValue) => {
  const directory = normalizeDirectory(value);
  if (directory === null) throw new TypeError("Cannot read properties of null (reading 'slice')");
  return directory.slice(SPACES_ROOT.length + 1).split('/')[0] ?? '';
};

export const isDirectoryOfSpace = (value: DirectoryValue, spaceId: string) => {
  const directory = normalizeDirectory(value);
  return directory !== null && isUnder(directory, spaceWorkPath(spaceId));
};

const matchesRoute = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`);

export function classifySpacePath(pathname: string) {
  const lower = pathname.toLowerCase();
  if (HOST_ONLY_ROUTES.some((route) => matchesRoute(lower, route))) return 'host_only';
  if (REFUSED_ACROSS_BOUNDARY_ROUTES.some((route) => matchesRoute(lower, route)) || SESSION_MOVE_ROUTE.test(lower)) {
    return 'refused_across_boundary';
  }
  return null;
}

const safeDecode = (value: DirectoryValue) => {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return value;
  }
};

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

export function requestedDirectories(req: Pick<IncomingMessage, 'headers'>, url: URL) {
  const directories: DirectoryValue[] = [];
  for (const key of ['directory', 'location[directory]']) {
    for (const value of url.searchParams.getAll(key)) directories.push(value);
  }
  const header = req.headers['x-opencode-directory'];
  if (header !== undefined && header.length > 0) {
    const encoded = req.headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(String(header));
    directories.push(encoded ? safeDecode(header) : header);
  }
  return directories;
}

export function spaceRouteOf(req: Pick<IncomingMessage, 'headers'>, url: URL): SpaceRoute | null {
  const prefixed = parseSpaceRoute(url.pathname);
  if (prefixed) return prefixed;
  if (!url.pathname.toLowerCase().startsWith('/api/')) return null;
  const named = requestedDirectories(req, url).find(isSpaceDirectory);
  return named === undefined ? null : { spaceId: spaceIdOfDirectory(named), path: url.pathname };
}

export const isSpaceRequest = (req: RouteRequest) => spaceRouteOf(req, new URL(String(req.originalUrl ?? req.url), 'http://localhost')) !== null;

const shortText = <Text,>(text: Text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_CHARACTERS);

const answer = (res: Response, status: number, code: string, message: string) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: message, code });
};

export const describeFailure = <Failure,>(error: Failure): SpaceFailure => {
  const code = error instanceof SpaceError ? spaceErrorProperty(error, 'code') : null;
  switch (code) {
    case 'space_not_found':
    case 'space_not_ours':
    case 'invalid_space_id':
      return { status: 404, code: 'space_not_found', message: 'There is no such space.' };
    case 'space_not_running':
    case 'space_move_unfinished':
    case 'place_unreachable':
      return { status: 503, code, message: shortText(spaceErrorProperty(error, 'message')) };
    case 'space_token_unreadable':
    case 'space_setup_failed':
    case 'space_login_failed':
      return { status: 502, code, message: shortText(spaceErrorProperty(error, 'message')) };
    case 'space_request_body_consumed':
      return { status: 500, code, message: shortText(spaceErrorProperty(error, 'message')) };
    case 'space_redirected':
      return { status: 502, code, message: shortText(spaceErrorProperty(error, 'message')) };
    default:
      return { status: 502, code: 'space_unreachable', message: `The server inside the space could not be reached: ${shortText(spaceErrorProperty(error, 'message') ?? error)}` };
  }
};

const parseSetCookie = (header: string[] | undefined) => {
  const line = header?.[0] ?? '';
  if (line.length === 0) return null;
  const [pair = '', ...attributes] = line.split(';');
  const equals = pair.indexOf('=');
  if (equals <= 0) return null;
  let ttlMs = DEFAULT_SESSION_TTL_MS;
  for (const attribute of attributes) {
    const [name = '', value] = attribute.trim().split('=');
    if (name.toLowerCase() === 'max-age' && /^\d+$/.test(value ?? '')) ttlMs = Number(value) * 1000;
  }
  return { cookie: pair.trim(), ttlMs };
};

const hasBody = (req: Pick<IncomingMessage, 'headers'>) => 'content-length' in req.headers || 'transfer-encoding' in req.headers;

export const forwardRequestHeaders = (requestHeaders: IncomingHttpHeaders, cookie: string) => {
  const headers: OutgoingHttpHeaders = {};
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

export const stripCredentialQuery = (url: URL) => {
  for (const parameter of DROPPED_QUERY_PARAMETERS) url.searchParams.delete(parameter);
};

export function createSpaceDispatcher({ transport, now = Date.now, logger = console, freeSocketTimeoutMs = FREE_SOCKET_TIMEOUT_MS }: SpaceDispatcherOptions) {
  const agents = new Map<string, http.Agent>();
  const tokens = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const logins = new Map<string, Promise<string>>();
  let known: KnownSpaces = { ids: new Set(), failure: null, readAt: -Infinity };
  let listing: Promise<void> | null = null;

  const readSpaceIds = async () => {
    if (!listing) {
      listing = transport.listSpaceIds()
        .then(({ ids, failure }) => { known = { ids: new Set(ids), failure, readAt: now() }; })
        .finally(() => { listing = null; });
    }
    await listing;
  };

  const isKnownSpace = async (spaceId: string) => {
    const age = now() - known.readAt;
    if (age >= LIST_TTL_MS || (!known.ids.has(spaceId) && age >= LIST_MISS_RETRY_MS)) {
      await readSpaceIds();
    }
    if (known.ids.has(spaceId)) return true;
    if (known.failure) throw known.failure;
    return false;
  };

  const agentFor = (spaceId: string) => {
    let agent = agents.get(spaceId);
    if (!agent) {
      agent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS_PER_SPACE, timeout: freeSocketTimeoutMs });
      Object.assign(agent, {
        createConnection(_options: http.ClientRequestArgs, callback: SpaceConnectionCallback) {
          transport.connect(spaceId).then((stream) => callback(null, stream), (error) => callback(error));
        },
      });
      agents.set(spaceId, agent);
    }
    return agent;
  };

  const tokenFor = async (spaceId: string, fresh: boolean) => {
    const cached = tokens.get(spaceId);
    if (!fresh && cached !== undefined) return cached;
    const token = await transport.readToken(spaceId);
    tokens.set(spaceId, token);
    return token;
  };

  const sendInside = (spaceId: string, { method, path: requestPath, headers, body }: { method: string; path: string; headers: OutgoingHttpHeaders; body: string }) => new Promise<{ status: number | undefined; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({
      agent: agentFor(spaceId),
      method,
      path: requestPath,
      timeout: LOGIN_TIMEOUT_MS,
      headers: { ...headers, host: `${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`, 'accept-encoding': 'identity', 'content-length': String(Buffer.byteLength(body)) },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new SpaceError('space_login_failed', 'The server inside the space did not answer the login in time')));
    request.on('error', reject);
    request.end(body);
  });

  const attemptLogin = async (spaceId: string, fresh: boolean) => {
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

  const logIn = (spaceId: string, { fresh }: { fresh: boolean }) => {
    const pending = logins.get(spaceId);
    if (pending !== undefined) return pending;
    const login = (async () => {
      let attempt = await attemptLogin(spaceId, fresh);
      if (!attempt.session && !fresh) {
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

  const sessionFor = async (spaceId: string) => {
    const session = sessions.get(spaceId);
    if (session && now() < session.renewAt) return session.cookie;
    return logIn(spaceId, { fresh: false });
  };

  const forgetSession = (spaceId: string) => { sessions.delete(spaceId); };

  const requestInside = async (spaceId: string, { method = 'GET', path: requestPath, headers = {}, body = null, timeoutMs = 0 }: InsideRequest) => {
    if (!await isKnownSpace(spaceId)) throw new SpaceError('space_not_found', `There is no space ${spaceId}`);
    const once = (cookie: string) => new Promise<InsideResponse>((resolve, reject) => {
      const options: http.ClientRequestArgs = {
        agent: agentFor(spaceId),
        method,
        path: requestPath,
        headers: { ...headers, host: `${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}`, cookie, 'accept-encoding': 'identity' },
      };
      if (timeoutMs > 0) options.timeout = timeoutMs;
      const request = http.request(options);
      if (timeoutMs > 0) {
        request.on('timeout', () => request.destroy(new SpaceError('space_unreachable', 'The server inside the space did not answer in time')));
      } else {
        request.setTimeout(0);
      }
      request.on('response', resolve);
      request.on('error', reject);
      request.end(body === null ? undefined : body);
    });
    let response;
    try {
      response = await once(await sessionFor(spaceId));
    } catch (error) {
      if (spaceErrorProperty(error, 'code') !== 'command_stream_failed') throw error;
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

  const applyResponseHeaders = (upstream: IncomingMessage, res: Response, innerPath: string) => {
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
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
  };

  const isEventStream = (upstream: IncomingMessage) => String(upstream.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');

  const pipeEventStream = (upstream: IncomingMessage, res: Response) => {
    const abort = new AbortController();
    let queue = Promise.resolve(true);
    const enqueue = (chunk: Buffer) => {
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
    upstream.on('data', (chunk: Buffer) => {
      enqueue(chunk).then((canContinue) => { if (!canContinue) stop(); });
    });
    upstream.on('end', () => { queue.then(() => { if (!res.writableEnded) res.end(); }); });
    upstream.on('error', () => { queue.then(() => { if (!res.writableEnded) res.end(); }); });
  };

  const forwardOnce = (req: Request, res: Response, { spaceId, innerPath, search, cookie, onUnauthorized }: ForwardRequest) => new Promise<ForwardOutcome>((resolve, reject) => {
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
    const settle = <Value,>(fn: (value: Value) => void) => (value: Value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const finish = settle(resolve);
    const fail = settle(reject);
    const onClientGone = () => { if (!res.writableFinished) upstreamRequest.destroy(); };
    res.on('close', onClientGone);

    upstreamRequest.on('response', (upstream: InsideResponse) => {
      if (res.destroyed) {
        upstream.destroy();
        finish('done');
        return;
      }
      if (upstream.statusCode === 401 && onUnauthorized === 'report') {
        upstream.resume();
        upstream.on('end', () => finish('unauthorized'));
        upstream.on('error', () => finish('unauthorized'));
        return;
      }
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.statusCode !== 304) {
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
      req.pipe(upstreamRequest);
      req.on('error', () => upstreamRequest.destroy());
    } else {
      upstreamRequest.end();
    }
  });

  const forward = async (req: Request, res: Response, spaceId: string, innerPath: string, search: string) => {
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
        if (spaceErrorProperty(error, 'code') !== 'command_stream_failed' || hasBody(req) || res.headersSent) throw error;
        outcome = await forwardOnce(req, res, { spaceId, innerPath, search, cookie, onUnauthorized: 'report' });
      }
      if (outcome !== 'unauthorized') return;
      forgetSession(spaceId);
      const renewed = await logIn(spaceId, { fresh: true });
      if (hasBody(req)) {
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

  const middleware: RequestHandler = (req, res, next) => {
    const url = new URL(req.originalUrl ?? req.url, 'http://localhost');
    const route = spaceRouteOf(req, url);
    if (!route) {
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

  const close = () => {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
    sessions.clear();
    tokens.clear();
  };

  const spaceSessions = {
    isKnownSpace,
    cookieFor: sessionFor,
    renew: (spaceId: string) => {
      forgetSession(spaceId);
      return logIn(spaceId, { fresh: true });
    },
  };

  return { middleware, close, isSpaceDirectory, isSpaceRequest, requestInside, spaceSessions };
}
