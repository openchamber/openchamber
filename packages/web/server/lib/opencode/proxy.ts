import http from 'node:http';
import https from 'node:https';

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  applyForwardProxyResponseHeaders,
  BROWSER_FETCH_METADATA_HEADERS,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from '../../proxy-headers.js';
import { createRealpathCache } from '../path-realpath-cache.js';
import { DEFAULT_UPSTREAM_STALL_TIMEOUT_MS } from '../event-stream/upstream-reader.js';
import { recordStartupPerformance } from '../diagnostics/startup-performance.js';
import { getWorktreeBootstrapStatus, waitForWorktreeRemoval } from '../git/service.js';
import { PART_SHELLS_HEADER, parsePartShellsHeader, shellMessagePage } from './message-shells.js';
import { diagnosticApiRoute, diagnosticErrorMessage } from '../diagnostics/vocabulary.js';
import { withUnreadBaseline } from '../openchamber-sessions/unread-baseline.js';
import { OPENCODE_TRUST_ROUTE, isGlobalRead, readMoveDestination, sessionMoveOf } from '../opencode-trust/index.js';
import { createSessionDirectoryResolver } from '../opencode-trust/session-directory.js';
import type { Application, Request, Response, NextFunction, RequestHandler } from '../shared/http-contracts.js';
import type { OpenCodeLifecycleState } from './lifecycle.js';
import type { RealpathCacheOptions } from '../path-realpath-cache.js';
import type { OpenCodeTrust, OpenCodeTrustAnswer } from '../opencode-trust/index.js';
import type { createHiddenSessionRegistry } from './hidden-sessions.js';
import type { createMcpOAuthSignIn } from './mcp-oauth.js';
import type { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { UnreadBaselineOverlay } from '../openchamber-sessions/unread-baseline.js';
import type { mergeSessionLists } from '../spaces/space-sessions.js';
import type { Socket } from 'node:net';

export interface OpenCodeProxyDependencies {
  fs?: { promises: { realpath: (directory: string) => Promise<string> } };
  OPEN_CODE_READY_GRACE_MS: number;
  LONG_REQUEST_TIMEOUT_MS: number;
  getRuntime: () => Pick<OpenCodeLifecycleState, 'openCodePort' | 'openCodeBaseUrl' | 'isOpenCodeReady' | 'openCodeNotReadySince' | 'isRestartingOpenCode'>;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  buildOpenCodeUrl: (route: string, prefix: string) => string;
  ensureOpenCodeApiPrefix: () => void;
  SSE_HEARTBEAT_INTERVAL_MS?: number;
  SSE_UPSTREAM_STALL_TIMEOUT_MS?: number;
  SESSION_UPSTREAM_TIMEOUT_MS?: number;
  getSseUpstreamStallTimeoutMs?: () => number;
  readWorktreeBootstrapStatus?: typeof getWorktreeBootstrapStatus;
  WORKTREE_READY_TIMEOUT_MS?: number;
  waitForWorktreeRemovalToSettle?: typeof waitForWorktreeRemoval;
  WORKTREE_REMOVAL_HOLD_MS?: number;
  getArchivedSessions?: (() => Promise<Record<string, number | null>>) | null;
  getStoredSessionMetadata?: (() => Promise<Record<string, SessionMetadata>>) | null;
  getUnreadBaseline?: (() => Promise<number | null>) | null;
  mergeSpaceSessionList?: (<Payload>(payload: Payload) => Promise<ReturnType<typeof mergeSessionLists<Payload>>>) | null;
  spaceEventHub?: Pick<ReturnType<typeof createGlobalMessageStreamHub>, 'subscribeEvent'> | null;
  hiddenSessions?: ReturnType<typeof createHiddenSessionRegistry> | null;
  openCodeTrust?: OpenCodeTrust | null;
  mcpOAuthSignIn?: ReturnType<typeof createMcpOAuthSignIn> | null;
}

interface ErrorFields {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

export interface SessionRevertMarker {
  messageID?: string;
  partID?: string;
}

export interface SanitizedSessionListItem {
  id?: unknown;
  parentID?: unknown;
  projectID?: unknown;
  location?: unknown;
  subpath?: unknown;
  title?: unknown;
  agent?: unknown;
  model?: unknown;
  cost?: unknown;
  tokens?: unknown;
  outcome?: unknown;
  time?: unknown;
  metadata?: unknown;
  fork?: unknown;
  revert?: SessionRevertMarker;
}

const hasErrorFields = (value: unknown): value is ErrorFields => value != null;
const optionalErrorFields = <Value>(value: Value) => hasErrorFields(value) ? value : undefined;
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
const isFunction = (value: unknown): value is (...args: never[]) => void => typeof value === 'function';
const hasResponseFields = (value: unknown): value is { status?: unknown } => value != null;
const isProxyResponse = (value: Response | Socket): value is Response => Boolean(value && hasResponseFields(value) && isFunction(value.status));

export interface UpstreamReadOptions {
  res?: Pick<Response, 'writableEnded' | 'destroyed' | 'once' | 'off'> | null;
  timeoutMs: number;
}

export const createUpstreamReadSignal = ({ res = null, timeoutMs }: UpstreamReadOptions) => {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const client = new AbortController();
  const abort = () => {
    if (res?.writableEnded) return;
    client.abort();
  };
  if (res?.destroyed) {
    abort();
  } else {
    res?.once?.('close', abort);
  }
  const signal = timeout ? AbortSignal.any([timeout, client.signal]) : client.signal;
  signal.addEventListener('abort', () => res?.off?.('close', abort), { once: true });
  return signal;
};

const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

const OPENCODE_AGENT_KEEP_ALIVE_MS = 30_000;
const OPENCODE_AGENT_MAX_FREE_SOCKETS = 256;
const OPENCODE_AGENT_IDLE_TIMEOUT_MS = 4_000;

const OPENCODE_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: OPENCODE_AGENT_KEEP_ALIVE_MS,
  maxSockets: Infinity,
  maxFreeSockets: OPENCODE_AGENT_MAX_FREE_SOCKETS,
  timeout: OPENCODE_AGENT_IDLE_TIMEOUT_MS,
};

const DIAGNOSTIC_PROXY_ERROR_CLASSES = new Map([
  ['ECONNREFUSED', 'connection_refused'],
  ['ECONNRESET', 'connection_reset'],
  ['ETIMEDOUT', 'timeout'],
  ['ESOCKETTIMEDOUT', 'timeout'],
  ['ENOTFOUND', 'dns_failed'],
  ['EAI_AGAIN', 'dns_failed'],
]);

const diagnosticProxyErrorClass = <Code>(code: Code) => isString(code) ? DIAGNOSTIC_PROXY_ERROR_CLASSES.get(code) : undefined;

const formatProxyFailure = <Failure>(req: Pick<Request, 'method' | 'originalUrl' | 'url'>, handler: string, failure: Failure, timedOut = false) => {
  const error = optionalErrorFields(failure);
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].some((method) => method === req?.method) ? req.method : 'OTHER';
  let route = '/api/other';
  try {
    const mapped = diagnosticApiRoute(new URL(req?.originalUrl || req?.url, 'http://localhost').pathname);
    if (mapped !== '/other') route = mapped;
  } catch { void 0; }
  let failureClass = timedOut ? 'timeout' : 'error';
  let message = 'unavailable';
  let cause = null;
  try {
    if (!timedOut) failureClass = diagnosticProxyErrorClass(error?.code) ?? diagnosticProxyErrorClass(optionalErrorFields(error?.cause)?.code) ?? 'error';
    message = diagnosticErrorMessage(error?.message) ?? 'unavailable';
    cause = diagnosticErrorMessage(optionalErrorFields(error?.cause)?.message);
  } catch { void 0; }
  return `method=${method} route=${route} function=${handler} class=${failureClass} message="${message}"${cause && cause !== message ? ` cause="${cause}"` : ''}`;
};

const isHttpsProxyTarget = (target: string | null | undefined) => {
  if (!isString(target)) {
    return false;
  }
  try {
    return new URL(target).protocol === 'https:';
  } catch {
    return /^https:/i.test(target.trim());
  }
};

export const createOpenCodeProxyAgent = (target: string | null | undefined) => (
  isHttpsProxyTarget(target)
    ? new https.Agent(OPENCODE_AGENT_OPTIONS)
    : new http.Agent(OPENCODE_AGENT_OPTIONS)
);

export const applyOwnedArchiveState = <Session>(session: Session, archivedById: Record<string, number | null> | null) => {
  if (!isObject(session) || !isString(session.id)) return session;
  if (!archivedById || !Object.prototype.hasOwnProperty.call(archivedById, session.id)) return session;
  const archivedAt = archivedById[session.id];
  const time = isObject(session.time) ? session.time : {};
  if (isNumber(archivedAt)) return { ...session, time: { ...time, archived: archivedAt } };
  if (!('archived' in time)) return session;
  const { archived: _dropped, ...rest } = time;
  return { ...session, time: rest };
};

const createOpenCodeProxyAgentResolver = (resolveTarget: () => string) => {
  const agents = new Map<string, http.Agent>();

  return () => {
    const target = resolveTarget();
    const scheme = isHttpsProxyTarget(target) ? 'https:' : 'http:';
    let agent = agents.get(scheme);
    if (!agent) {
      agent = createOpenCodeProxyAgent(target);
      agents.set(scheme, agent);
    }
    return agent;
  };
};

export const createDirectoryQueryCanonicalizer = ({ realpath, ...cacheOptions }: RealpathCacheOptions = {}) => {
  const realpathCache = createRealpathCache({ fallbackOnError: true, realpath, ...cacheOptions });

  return async (requestUrl: string) => {
    if (!requestUrl.includes('directory=')) {
      return requestUrl;
    }

    const url = new URL(requestUrl, 'http://localhost');
    const directory = url.searchParams.get('directory');
    if (!directory) {
      return requestUrl;
    }

    const canonicalDirectory = await realpathCache.resolve(directory);
    if (!canonicalDirectory || canonicalDirectory === directory) {
      return requestUrl;
    }

    url.searchParams.set('directory', canonicalDirectory);
    return `${url.pathname}${url.search}`;
  };
};

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

const directoriesAsOpenCodeReadsThem = (req: Request, url: URL) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = req.get('x-opencode-directory');
  if (header) {
    let directory = header;
    if (req.get('x-opencode-directory-encoding') === 'uri' || PERCENT_ESCAPE.test(header)) {
      try {
        directory = decodeURIComponent(header);
      } catch {
        void 0;
      }
    }
    directories.push(directory);
  }
  return directories;
};

export const normalizeForwardedDirectoryHeaders = <Headers extends http.IncomingHttpHeaders>(headers: Headers) => {
  const writableHeaders: http.IncomingHttpHeaders = headers;
  const rawDirectory = headers?.['x-opencode-directory'];
  if (!isString(rawDirectory)) {
    return headers;
  }

  if (headers['x-opencode-directory-encoding'] !== 'uri') {
    return headers;
  }

  try {
    const decodedDirectory = decodeURIComponent(rawDirectory);
    try {
      http.validateHeaderValue('x-opencode-directory', decodedDirectory);
    } catch {
      return headers;
    }
    writableHeaders['x-opencode-directory'] = decodedDirectory;
  } catch {
    void 0;
  }
  delete headers['x-opencode-directory-encoding'];
  return headers;
};

const waitForSseDrain = (res: Response, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted || res.writableEnded || res.destroyed) {
    resolve();
    return;
  }

  const cleanup = () => {
    res.off?.('drain', onDone);
    res.off?.('close', onDone);
    res.off?.('error', onDone);
    signal?.removeEventListener?.('abort', onDone);
  };
  const onDone = () => {
    cleanup();
    resolve();
  };

  res.once?.('drain', onDone);
  res.once?.('close', onDone);
  res.once?.('error', onDone);
  signal?.addEventListener?.('abort', onDone, { once: true });
});

export const writeSseChunkWithBackpressure = async (res: Response, value: string | Uint8Array | undefined, signal?: AbortSignal) => {
  if (!value || value.length === 0 || signal?.aborted || res.writableEnded || res.destroyed) {
    return false;
  }

  const flushed = res.write(value);
  if (flushed !== false) {
    return true;
  }

  await waitForSseDrain(res, signal);
  return !signal?.aborted && !res.writableEnded && !res.destroyed;
};

export const createSseBoundaryTracker = () => {
  const decoder = new TextDecoder();
  let tail = '';

  const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    observe(value: string | Uint8Array) {
      const text = isString(value)
        ? value
        : decoder.decode(value, { stream: true });
      if (text.length > 0) {
        tail = `${tail}${normalize(text)}`;
        if (tail.length > 4096) {
          tail = tail.slice(-4096);
        }
      }
      return this.isAtBoundary();
    },
    isAtBoundary() {
      return tail.length === 0 || tail.endsWith('\n\n');
    },
  };
};

const SESSION_LIST_ALLOWED_FIELDS = [
  'id',
  'parentID',
  'projectID',
  'location',
  'subpath',
  'title',
  'agent',
  'model',
  'cost',
  'tokens',
  'outcome',
  'time',
  'metadata',
  'fork',
] as const;

const RETIRED_SESSION_METADATA_KEYS = ['knowledge_context_delivered'];

const withoutRetiredMetadataKeys = <Metadata>(metadata: Metadata) => {
  const openchamber = hasMetadataFields(metadata) ? metadata.openchamber : undefined;
  if (!isObject(openchamber) || !RETIRED_SESSION_METADATA_KEYS.some((key) => key in openchamber)) return metadata;
  const kept = { ...openchamber };
  for (const key of RETIRED_SESSION_METADATA_KEYS) delete kept[key];
  return { ...metadata, openchamber: kept };
};

const hasMetadataFields = (value: unknown): value is { openchamber?: unknown } => value != null;

export const sanitizeSessionListItem = <Session>(session: Session) => {
  if (!isObject(session) || Array.isArray(session)) {
    return session;
  }

  const sanitized: SanitizedSessionListItem = {};
  for (const key of SESSION_LIST_ALLOWED_FIELDS) {
    if (key in session) {
      sanitized[key] = session[key];
    }
  }

  if ('metadata' in sanitized) sanitized.metadata = withoutRetiredMetadataKeys(sanitized.metadata);

  const revert = session.revert;
  if (isObject(revert) && !Array.isArray(revert)) {
    const revertMarker: SessionRevertMarker = {};
    if (isString(revert.messageID)) {
      revertMarker.messageID = revert.messageID;
    }
    if (isString(revert.partID)) {
      revertMarker.partID = revert.partID;
    }
    if (Object.keys(revertMarker).length > 0) {
      sanitized.revert = revertMarker;
    }
  }

  return sanitized;
};

const sanitizeSessionListPayload = <Payload>(payload: Payload) => {
  if (Array.isArray(payload)) {
    return payload.map((session) => sanitizeSessionListItem(session));
  }
  if (isObject(payload) && Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.map((session) => sanitizeSessionListItem(session)) };
  }
  return payload;
};

const sessionListRecords = <Payload>(payload: Payload): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload) && Array.isArray(payload.data)) return payload.data;
  return null;
};

export const registerOpenCodeProxy = (app: Application, deps: OpenCodeProxyDependencies) => {
  const {
    fs,
    OPEN_CODE_READY_GRACE_MS,
    LONG_REQUEST_TIMEOUT_MS,
    getRuntime,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    SSE_HEARTBEAT_INTERVAL_MS = DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
    SSE_UPSTREAM_STALL_TIMEOUT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
    SESSION_UPSTREAM_TIMEOUT_MS: sessionUpstreamTimeoutOverrideMs,
    getSseUpstreamStallTimeoutMs = () => SSE_UPSTREAM_STALL_TIMEOUT_MS,
    readWorktreeBootstrapStatus = getWorktreeBootstrapStatus,
    WORKTREE_READY_TIMEOUT_MS = 5 * 60 * 1000,
    waitForWorktreeRemovalToSettle = waitForWorktreeRemoval,
    WORKTREE_REMOVAL_HOLD_MS = 60 * 1000,
    getArchivedSessions = null,
    getStoredSessionMetadata = null,
    getUnreadBaseline = null,
    mergeSpaceSessionList = null,
    spaceEventHub = null,
    hiddenSessions = null,
    openCodeTrust = null,
    mcpOAuthSignIn = null,
  } = deps;

  const readArchivedSessions = async () => {
    if (!getArchivedSessions) return null;
    try {
      const archived = await getArchivedSessions();
      return isObject(archived) ? archived : null;
    } catch (error) {
      console.warn('[proxy] archive state unavailable:', optionalErrorFields(error)?.message ?? error);
      return null;
    }
  };

  const readStoredSessionMetadata = async () => {
    if (!getStoredSessionMetadata) return null;
    try {
      const stored = await getStoredSessionMetadata();
      return isObject(stored) && Object.keys(stored).length > 0 ? stored : null;
    } catch (error) {
      console.warn('[proxy] session metadata unavailable:', optionalErrorFields(error)?.message ?? error);
      return null;
    }
  };

  const readUnreadBaseline = async () => {
    if (!getUnreadBaseline) return null;
    try {
      const since = await getUnreadBaseline();
      return Number.isSafeInteger(since) ? since : null;
    } catch (error) {
      console.warn('[proxy] unread baseline unavailable:', optionalErrorFields(error)?.message ?? error);
      return null;
    }
  };

  const withStoredMetadata = <Session>(session: Session, stored: Record<string, SessionMetadata>) => {
    if (!isObject(session) || !isString(session.id)) return session;
    const ours = stored[session.id];
    if (!isObject(ours) || Array.isArray(ours)) return session;
    return { ...session, metadata: withoutRetiredMetadataKeys(ours) };
  };

  type OwnedState = Awaited<ReturnType<typeof readOwnedState>>;
  const overlaySession = <Session>(session: Session, { archived, stored, unreadSince }: OwnedState) => {
    let result: Session | UnreadBaselineOverlay = session;
    if (archived) result = applyOwnedArchiveState(result, archived);
    if (stored) result = withStoredMetadata(result, stored);
    if (unreadSince !== null) result = withUnreadBaseline(result, unreadSince);
    return result;
  };

  const readOwnedState = async () => {
    const [archived, stored, unreadSince] = await Promise.all([
      readArchivedSessions(),
      readStoredSessionMetadata(),
      readUnreadBaseline(),
    ]);
    return { archived, stored, unreadSince };
  };

  const hasOwnedState = ({ archived, stored, unreadSince }: OwnedState) => Boolean(archived || stored || unreadSince !== null);

  const overlayOwnedStateOnList = async <Payload>(payload: Payload) => {
    const records = sessionListRecords(payload);
    if (!records) return payload;
    const owned = await readOwnedState();
    if (!hasOwnedState(owned)) return payload;
    const overlaid = records.map((session) => overlaySession(session, owned));
    return Array.isArray(payload) ? overlaid : { ...payload, data: overlaid };
  };

  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  const runtime = getRuntime();
  if (runtime.openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${runtime.openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  mcpOAuthSignIn?.registerCallbackRoute(app);

  if (openCodeTrust) {
    app.all(OPENCODE_TRUST_ROUTE, async (req, res) => {
      try {
        const result = await openCodeTrust.handleRoute({ method: req.method || '', query: req.query, body: req.body });
        res.setHeader('Cache-Control', 'no-store');
        res.status(result.status).json(result.body);
      } catch (error) {
        console.error('[proxy] OpenCode trust check failed:', optionalErrorFields(error)?.message ?? error);
        res.status(500).json({ error: 'Failed to check the folder configuration' });
      }
    });
  }

  const isAbortError = <Failure>(error: Failure) => optionalErrorFields(error)?.name === 'AbortError';
  const sessionRouteErrorStatus = <Failure>(error: Failure) => {
    if (isAbortError(error)) return null;
    return isProxyTimeoutError(error) ? 504 : 503;
  };
  const FALLBACK_PROXY_TARGET = 'http://127.0.0.1:3902';
  const canonicalizeDirectoryQuery = createDirectoryQueryCanonicalizer({
    realpath: fs?.promises?.realpath?.bind(fs.promises),
  });

  const hasParsedBodyValue = <Body>(body: Body) => {
    if (body === undefined || body === null) return false;
    if (Buffer.isBuffer(body)) return body.length > 0;
    if (isString(body)) return body.length > 0;
    if (Array.isArray(body)) return body.length > 0;
    if (isObject(body)) return Object.keys(body).length > 0;
    return true;
  };

  const getContentType = (proxyReq: http.ClientRequest, req: Request) => {
    const value = proxyReq.getHeader?.('content-type') ?? req.headers?.['content-type'] ?? '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value || '');
  };

  const serializeUrlEncodedBody = <Body>(body: Body) => {
    if (!isObject(body) || Buffer.isBuffer(body)) {
      return String(body ?? '');
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry !== undefined && entry !== null) params.append(key, String(entry));
        }
        continue;
      }
      params.append(key, String(value));
    }
    return params.toString();
  };

  const serializeParsedBody = (req: Request, proxyReq: http.ClientRequest) => {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    if (req.body === undefined || req.body === null) return null;
    const originalContentLength = Number.parseInt(req.headers?.['content-length'] || '0', 10) || 0;
    if (!hasParsedBodyValue(req.body) && originalContentLength <= 0) return null;

    const contentType = getContentType(proxyReq, req).toLowerCase();
    if (Buffer.isBuffer(req.body)) return req.body;
    if (contentType.includes('application/json')) return Buffer.from(JSON.stringify(req.body));
    if (contentType.includes('application/x-www-form-urlencoded')) return Buffer.from(serializeUrlEncodedBody(req.body));
    if (isString(req.body)) return Buffer.from(req.body);
    return null;
  };

  const replayParsedBody = (proxyReq: http.ClientRequest, req: Request) => {
    const body = serializeParsedBody(req, proxyReq);
    if (!body) {
      if (proxyReq.getHeader('content-length') !== undefined) {
        proxyReq.removeHeader('transfer-encoding');
      }
      return;
    }
    proxyReq.removeHeader('transfer-encoding');
    proxyReq.setHeader('content-length', String(body.length));
    proxyReq.write(body);
  };

  const normalizeProxyTarget = (candidate: string | null) => {
    if (!isString(candidate)) {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  };

  const resolveProxyTarget = () => {
    const runtimeState = getRuntime();

    if (runtimeState.openCodePort) {
      try {
        const resolved = normalizeProxyTarget(buildOpenCodeUrl('/', ''));
        if (resolved) {
          return resolved;
        }
      } catch {
        void 0;
      }
    }

    const externalBase = normalizeProxyTarget(runtimeState.openCodeBaseUrl);
    if (externalBase) {
      return externalBase;
    }

    return FALLBACK_PROXY_TARGET;
  };

  const normalizeProxyTimeout = (value: number) => {
    return Number.isFinite(value) && value >= 0 ? value : 4 * 60 * 1000;
  };

  const PROXY_REQUEST_TIMEOUT_MS = normalizeProxyTimeout(LONG_REQUEST_TIMEOUT_MS);
  const SESSION_UPSTREAM_TIMEOUT_MS = sessionUpstreamTimeoutOverrideMs ?? PROXY_REQUEST_TIMEOUT_MS;
  const PROXY_TIMEOUT_MARKER = Symbol('openchamberProxyTimedOut');
  interface ProxyRequest extends Request {
    [PROXY_TIMEOUT_MARKER]?: boolean;
  }


  const isProxyTimeoutError = <Failure>(failure: Failure) => {
    const error = optionalErrorFields(failure);
    const code = isString(error?.code) ? error.code : '';
    const message = isString(error?.message) ? error.message.toLowerCase() : '';
    return code === 'ETIMEDOUT'
      || code === 'ESOCKETTIMEDOUT'
      || message.includes('timeout')
      || message.includes('timed out');
  };

  const sendProxyErrorResponse = (res: Response | Socket, statusCode: number) => {
    if (!res || ('headersSent' in res && res.headersSent) || res.writableEnded || !isProxyResponse(res)) {
      return false;
    }
    res.status(statusCode).json({ error: statusCode === 504 ? 'OpenCode upstream timed out' : 'OpenCode service unavailable' });
    return true;
  };

  const applyProxyResponseDeadline = (req: ProxyRequest, res: Response, next: NextFunction) => {
    if (PROXY_REQUEST_TIMEOUT_MS <= 0) {
      next();
      return;
    }
    const timeout = setTimeout(() => {
      req[PROXY_TIMEOUT_MARKER] = true;
      if (sendProxyErrorResponse(res, 504)) {
        res.once('finish', () => req.destroy?.());
      }
    }, PROXY_REQUEST_TIMEOUT_MS);
    timeout.unref?.();

    const clear = () => clearTimeout(timeout);
    res.once('finish', clear);
    res.once('close', clear);
    next();
  };

  const forwardSseRequest = async (req: Request, res: Response) => {
    const abortController = new AbortController();
    const closeUpstream = () => abortController.abort();
    let upstream: globalThis.Response | null = null;
    let reader: ReturnType<NonNullable<globalThis.Response['body']>['getReader']> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let upstreamStallTimer: ReturnType<typeof setTimeout> | null = null;
    let didUpstreamStall = false;
    let unsubscribeSpaceEvents: (() => void) | null = null;
    let writeQueue = Promise.resolve(true);
    const sseBoundary = createSseBoundaryTracker();

    req.on('close', closeUpstream);

    try {
      const requestUrl = req.originalUrl.length > 0
        ? req.originalUrl
        : req.url;
      const upstreamPath = requestUrl;
      const headers = normalizeForwardedDirectoryHeaders(
        collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders())
      );
      headers.accept ??= 'text/event-stream';
      headers['cache-control'] ??= 'no-cache';

      upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      res.status(upstream.status);
      applyForwardProxyResponseHeaders(upstream.headers, res);

      const contentType = upstream.headers.get('content-type') || 'text/event-stream';
      const isEventStream = contentType.toLowerCase().includes('text/event-stream');

      if (!upstream.body) {
        res.end(await upstream.text().catch(() => ''));
        return;
      }

      if (!isEventStream) {
        res.end(await upstream.text());
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (res.socket) {
        res.socket.setNoDelay(true);
      }

      const scheduleHeartbeat = () => {
        heartbeatTimer = setTimeout(async () => {
          if (abortController.signal.aborted || res.writableEnded || res.destroyed) {
            return;
          }
          if (!sseBoundary.isAtBoundary()) {
            scheduleHeartbeat();
            return;
          }
          const canContinue = await enqueueSseWrite(':heartbeat\n\n');
          if (canContinue) {
            scheduleHeartbeat();
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
      };

      const clearUpstreamStallTimer = () => {
        clearTimeout(upstreamStallTimer ?? undefined);
        upstreamStallTimer = null;
      };

      const resetUpstreamStallTimer = () => {
        clearUpstreamStallTimer();
        upstreamStallTimer = setTimeout(() => {
          didUpstreamStall = true;
          abortController.abort();
        }, getSseUpstreamStallTimeoutMs());
        upstreamStallTimer.unref?.();
      };

      const enqueueSseWrite = (value: string | Uint8Array | undefined) => {
        writeQueue = writeQueue
          .catch(() => false)
          .then((canContinue) => {
            if (!canContinue) {
              return false;
            }
            return writeSseChunkWithBackpressure(res, value, abortController.signal);
          });
        return writeQueue;
      };

      const isGlobalStream = !new URL(requestUrl, 'http://localhost').searchParams.get('directory') && !req.get('x-opencode-directory');
      const pendingSpaceBlocks: string[] = [];
      const flushSpaceBlocks = async () => {
        while (pendingSpaceBlocks.length > 0 && sseBoundary.isAtBoundary() && !abortController.signal.aborted) {
          const canContinue = await enqueueSseWrite(pendingSpaceBlocks.shift());
          if (!canContinue) return false;
        }
        return true;
      };
      if (spaceEventHub && isGlobalStream) {
        unsubscribeSpaceEvents = spaceEventHub.subscribeEvent((event) => {
          if (event.spaceId === null) return;
          pendingSpaceBlocks.push(`data: ${JSON.stringify(event.payload)}\n\n`);
          void flushSpaceBlocks();
        }, { spaces: true });
      }

      scheduleHeartbeat();
      resetUpstreamStallTimer();

      reader = upstream.body.getReader();
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          resetUpstreamStallTimer();
          sseBoundary.observe(value);
          const canContinue = await enqueueSseWrite(value);
          if (!canContinue) {
            break;
          }
          if (!await flushSpaceBlocks()) {
            break;
          }
        }
      }

      res.end();
    } catch (error) {
      if (isAbortError(error)) {
        if (didUpstreamStall && !res.writableEnded && !res.destroyed) {
          await writeQueue.catch(() => false);
          res.end();
        }
        return;
      }
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardSseRequest', error)}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
      } else {
        res.end();
      }
    } finally {
      unsubscribeSpaceEvents?.();
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (upstreamStallTimer) {
        clearTimeout(upstreamStallTimer);
        upstreamStallTimer = null;
      }
      req.off('close', closeUpstream);
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        } else if (upstream?.body && !upstream.body.locked) {
          await upstream.body.cancel();
        }
      } catch {
        void 0;
      }
    }
  };

  const fetchSessionListPayload = async (upstreamPath: string, { req = null, signal = null, timeoutMs = SESSION_UPSTREAM_TIMEOUT_MS }: { req?: Request | null; signal?: AbortSignal | null; timeoutMs?: number } = {}) => {
    const headers = req
      ? {
          ...normalizeForwardedDirectoryHeaders(collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders())),
          accept: 'application/json',
          'accept-encoding': 'identity',
        }
      : {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
          'accept-encoding': 'identity',
        };
    const upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
      method: 'GET',
      headers,
      signal: signal ?? createUpstreamReadSignal({ timeoutMs }),
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const bodyText = await upstream.text();
    const isJson = contentType.toLowerCase().includes('application/json');

    if (!isJson) {
      return { upstream, contentType, bodyText, payload: null, isJson: false };
    }

    try {
      const payload: unknown = JSON.parse(bodyText);
      return { upstream, contentType, bodyText, payload, isJson: true, parseError: null };
    } catch (parseError) {
      return { upstream, contentType, bodyText, payload: null, isJson: true, parseError };
    }
  };

  const getRequestUpstreamPath = async (req: Request) => {
    const requestUrl = req.originalUrl.length > 0
      ? req.originalUrl
      : req.url;
    return canonicalizeDirectoryQuery(requestUrl);
  };

  const forwardSanitizedSessionListRequest: RequestHandler = async (req, res, next) => {
    try {
      const signal = createUpstreamReadSignal({ res, timeoutMs: SESSION_UPSTREAM_TIMEOUT_MS });
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req, signal });

      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);

      if (!result.isJson) {
        res.setHeader('content-type', result.contentType);
        res.end(result.bodyText);
        return;
      }

      if (result.parseError || !sessionListRecords(result.payload)) {
        res.setHeader('content-type', result.contentType);
        res.end(result.bodyText);
        return;
      }

      res.setHeader('content-type', result.contentType);
      const visible = hiddenSessions ? hiddenSessions.filterSessionList(result.payload) : result.payload;
      const hostList = await overlayOwnedStateOnList(sanitizeSessionListPayload(visible));
      const listQuery = new URL(upstreamPath, 'http://localhost').searchParams;
      const scopedToDirectory = Boolean(listQuery.get('directory') || req.get('x-opencode-directory'));
      const wantsSpaces = mergeSpaceSessionList && !listQuery.get('cursor') && !scopedToDirectory;
      res.json(wantsSpaces ? await mergeSpaceSessionList(hostList) : hostList);
    } catch (error) {
      const status = sessionRouteErrorStatus(error);
      if (status === null) {
        return;
      }
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardSanitizedSessionListRequest', error, status === 504)}`);
      if (!res.headersSent) {
        res.status(status).json({ error: status === 504 ? 'OpenCode upstream timed out' : 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  };

  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  const READINESS_HOLD_POLL_MS = 75;
  const READINESS_HOLD_MAX_MS = 6000;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const isStillWaiting = (runtimeState: ReturnType<OpenCodeProxyDependencies['getRuntime']>) => {
    const waitElapsed = runtimeState.openCodeNotReadySince === 0 ? 0 : Date.now() - runtimeState.openCodeNotReadySince;
    return (
      (!runtimeState.isOpenCodeReady && (runtimeState.openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      runtimeState.isRestartingOpenCode ||
      !runtimeState.openCodePort
    );
  };
  const classifyReadinessRoute = (requestPath: string) => {
    if (/^\/session\/[^/]+\/message(?:\/|$)/.test(requestPath)) return 'session-messages';
    if (requestPath === '/session' || requestPath.startsWith('/session/')) return 'session';
    if (requestPath === '/event') return 'events';
    return 'other';
  };

  app.use('/api', async (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    if (!isStillWaiting(getRuntime())) {
      return next();
    }

    const holdStartedAt = performance.now();
    const routeClass = classifyReadinessRoute(req.path);
    const deadline = Date.now() + Math.min(OPEN_CODE_READY_GRACE_MS, READINESS_HOLD_MAX_MS);
    while (Date.now() < deadline) {
      if (res.writableEnded || req.aborted) {
        recordStartupPerformance('proxy.readiness-hold', {
          durationMs: performance.now() - holdStartedAt,
          outcome: 'aborted',
          routeClass,
        });
        return;
      }
      await sleep(READINESS_HOLD_POLL_MS);
      if (!isStillWaiting(getRuntime())) {
        recordStartupPerformance('proxy.readiness-hold', {
          durationMs: performance.now() - holdStartedAt,
          outcome: 'ready',
          routeClass,
        });
        return next();
      }
    }

    recordStartupPerformance('proxy.readiness-hold', {
      durationMs: performance.now() - holdStartedAt,
      outcome: 'timeout',
      routeClass,
    });
    if (!res.headersSent) {
      res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }
  });

  app.use('/api', async (req, _res, next) => {
    const named = directoriesAsOpenCodeReadsThem(req, new URL(req.url, 'http://localhost'));
    if (named.length === 0) return next();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(named.map((directory) => waitForWorktreeRemovalToSettle(directory))),
        new Promise((resolve) => { holdTimer = setTimeout(resolve, WORKTREE_REMOVAL_HOLD_MS); }),
      ]);
    } catch (error) {
      return next(error);
    } finally {
      clearTimeout(holdTimer);
    }
    next();
  });

  const resolveSessionDirectory = createSessionDirectoryResolver({ fetchImpl: fetch, buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const parseJsonBody = express.json({ limit: '64kb' });
  const readBody = (req: Request, res: Response) => new Promise<unknown>((resolve, reject) => {
    parseJsonBody(req, res, (error) => (error ? reject(error) : resolve(req.body)));
  });

  const checkoutGateFolders = async (req: Request, res: Response, url: URL): Promise<{ folders: string[]; refusal?: never } | { refusal: OpenCodeTrustAnswer; folders?: never }> => {
    const folders = directoriesAsOpenCodeReadsThem(req, url).filter(Boolean);
    const movedSessionID = sessionMoveOf(req.method || '', new URL(req.originalUrl || req.url, 'http://localhost').pathname);
    if (!movedSessionID) return { folders };
    let source;
    try {
      source = await resolveSessionDirectory(movedSessionID, { fresh: true });
    } catch {
      return { refusal: { status: 503, body: { error: 'Could not read the folder of the session being moved' } } };
    }
    const { refusal, destination } = await readMoveDestination(() => readBody(req, res), source);
    if (refusal) return { refusal };
    if (destination) folders.push(destination);
    if (source) folders.push(source);
    return { folders };
  };

  app.use('/api', async (req, res, next) => {
    normalizeForwardedDirectoryHeaders(req.headers);
    const url = new URL(req.url, 'http://localhost');
    const deadline = Date.now() + WORKTREE_READY_TIMEOUT_MS;
    try {
      const { folders, refusal } = await checkoutGateFolders(req, res, url);
      if (refusal) return res.status(refusal.status).json(refusal.body);
      if (folders.length === 0) return next();
      while (!res.destroyed && !res.writableEnded && !req.aborted) {
        const statuses = await Promise.all(folders.map((folder) => readWorktreeBootstrapStatus(folder)));
        if (res.destroyed || res.writableEnded || req.aborted) return;
        const failed = statuses.find((status) => status.status === 'failed');
        if (failed) {
          const pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname;
          if (isGlobalRead(req.method || '', pathname)) return next();
          return res.status(503).json({ error: failed.error || 'Worktree bootstrap failed' });
        }
        if (statuses.every((status) => status.status === 'ready' || status.phase === 'git-ready' || status.phase === 'setup-ready')) {
          return next();
        }
        if (Date.now() >= deadline) {
          return res.status(503).json({ error: 'Timed out waiting for worktree checkout' });
        }
        await sleep(75);
      }
    } catch (error) {
      next(error);
    }
  });

  if (openCodeTrust) {
    app.use('/api', async (req, res, next) => {
      try {
        const refusal = await openCodeTrust.refusalFor({
          method: req.method || '',
          path: req.originalUrl || req.url,
          headers: req.headers,
          resolveSessionDirectory,
          readBody: () => readBody(req, res),
        });
        if (!refusal) return next();
        if (!res.headersSent) res.status(refusal.status).json(refusal.body);
      } catch (error) {
        next(error);
      }
    });
  }

  app.get('/api/session', (req, res, next) => {
    return forwardSanitizedSessionListRequest(req, res, next);
  });

  app.get('/api/session/active', async (req, res, next) => {
    if (!hiddenSessions) return next();
    try {
      const result = await fetchSessionListPayload(await getRequestUpstreamPath(req), { req });
      res.status(result.upstream.status);
      res.setHeader('content-type', result.contentType);
      if (!result.isJson || result.parseError || !result.upstream.ok) {
        res.end(result.bodyText);
        return;
      }
      res.json(hiddenSessions.filterActive(result.payload));
    } catch (error) {
      const status = sessionRouteErrorStatus(error);
      if (status === null) return;
      if (!res.headersSent) res.status(status).json({ error: 'OpenCode service unavailable' });
    }
  });

  app.get('/api/session/:sessionID', async function forwardSessionGetRequest(req, res, next) {
    if (
      !getArchivedSessions
      && !getStoredSessionMetadata
      && !getUnreadBaseline
    ) return next();
    try {
      const signal = createUpstreamReadSignal({ res, timeoutMs: SESSION_UPSTREAM_TIMEOUT_MS });
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req, signal });

      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.setHeader('content-type', result.contentType);

      const record = result.isJson && !result.parseError ? result.payload : null;
      const session = isObject(record) && !Array.isArray(record)
        ? (isObject(record.data) ? record.data : record)
        : null;
      if (!isObject(session) || !isString(session.id)) {
        res.end(result.bodyText);
        return;
      }

      const owned = await readOwnedState();
      if (!hasOwnedState(owned)) {
        res.end(result.bodyText);
        return;
      }

      const overlaid = overlaySession(session, owned);
      res.json(isObject(record) && isObject(record.data) ? { ...record, data: overlaid } : overlaid);
    } catch (error) {
      const status = sessionRouteErrorStatus(error);
      if (status === null) return;
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardSessionGetRequest', error, status === 504)}`);
      if (!res.headersSent) {
        res.status(status).json({ error: status === 504 ? 'OpenCode upstream timed out' : 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  });

  app.get('/api/session/:sessionID/message', async function forwardMessageListRequest(req, res, next) {
    const keepWhole = parsePartShellsHeader(req.get(PART_SHELLS_HEADER));
    if (!keepWhole) return next();
    try {
      const signal = createUpstreamReadSignal({ res, timeoutMs: SESSION_UPSTREAM_TIMEOUT_MS });
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req, signal });
      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.setHeader('content-type', result.contentType);
      if (!result.isJson || result.parseError || !result.upstream.ok) {
        res.end(result.bodyText);
        return;
      }
      res.json(shellMessagePage(result.payload, keepWhole));
    } catch (error) {
      const status = sessionRouteErrorStatus(error);
      if (status === null) return;
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardMessageListRequest', error, status === 504)}`);
      if (!res.headersSent) {
        res.status(status).json({ error: status === 504 ? 'OpenCode upstream timed out' : 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  });

  app.get('/api/global/event', (req, res) => {
    req.url = req.url.replace('/api/global/event', '/api/event');
    req.originalUrl = req.originalUrl.replace('/api/global/event', '/api/event');
    return forwardSseRequest(req, res);
  });
  app.get('/api/event', forwardSseRequest);

  const resolveOpenCodeProxyAgent = createOpenCodeProxyAgentResolver(resolveProxyTarget);

  const createApiProxy = (timeoutMs: number) => createProxyMiddleware<ProxyRequest, Response>({
    target: resolveProxyTarget(),
    get agent() {
      return resolveOpenCodeProxyAgent();
    },
    changeOrigin: true,
    timeout: timeoutMs,
    proxyTimeout: timeoutMs,
    pathRewrite: (proxiedPath) => `/api${proxiedPath === '/' ? '' : proxiedPath}`,
    router: () => resolveProxyTarget(),
    on: {
      proxyReq: (proxyReq, req, res) => {
        const onClientClose = () => {
          if (!res.writableEnded) proxyReq.destroy();
        };
        res.once('close', onClientClose);
        proxyReq.once('close', () => res.off('close', onClientClose));
        if (res.destroyed) onClientClose();

        const authHeaders = getOpenCodeAuthHeaders();
        if (authHeaders.Authorization) {
          proxyReq.setHeader('Authorization', authHeaders.Authorization);
        }

        proxyReq.setHeader('accept-encoding', 'identity');

        for (const name of BROWSER_FETCH_METADATA_HEADERS) proxyReq.removeHeader(name);

        replayParsedBody(proxyReq, req);
      },
      proxyRes: (proxyRes) => {
        for (const key of Object.keys(proxyRes.headers || {})) {
          if (!shouldForwardProxyResponseHeader(key)) {
            delete proxyRes.headers[key];
          }
        }
      },
      error: function onApiProxyError(err, req, res) {
        if (
          req?.aborted ||
          res?.writableEnded ||
          res?.destroyed ||
          req?.socket?.destroyed ||
          ('socket' in res && res.socket?.destroyed)
        ) {
          return;
        }
        console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'onApiProxyError', err, Boolean(req?.[PROXY_TIMEOUT_MARKER]))}`);
        if (req?.[PROXY_TIMEOUT_MARKER]) {
          return;
        }
        const statusCode = isProxyTimeoutError(err) ? 504 : 503;
        sendProxyErrorResponse(res, statusCode);
      },
    },
  });

  const apiProxy = createApiProxy(PROXY_REQUEST_TIMEOUT_MS);

  app.use('/api', async (req, _res, next) => {
    try {
      const rewrittenUrl = await canonicalizeDirectoryQuery(req.url);
      if (rewrittenUrl !== req.url) {
        req.url = rewrittenUrl;
      }
    } catch {
      void 0;
    }
    next();
  });

  app.use('/api', applyProxyResponseDeadline);
  mcpOAuthSignIn?.registerStartRoutes(app, { readBody });
  app.use('/api', apiProxy);
};
