import http from 'node:http';
import https from 'node:https';

import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from '../../proxy-headers.js';
import { createRealpathCache } from '../path-realpath-cache.js';
import { DEFAULT_UPSTREAM_STALL_TIMEOUT_MS } from '../event-stream/upstream-reader.js';
import { createSseCursor } from '../event-stream/sse-cursor.js';
import { recordStartupPerformance } from './startup-performance.js';
import { beginUpstreamRequest } from './upstream-requests.js';
import { getWorktreeBootstrapStatus, waitForWorktreeRemoval } from '../git/service.js';
import { PART_SHELLS_HEADER, parsePartShellsHeader, shellMessagePage } from './message-shells.js';
import { diagnosticApiRoute, diagnosticErrorMessage } from '../diagnostics/vocabulary.js';
import { readBoundedResponseText } from '../shared/response-body.js';

const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 20_000;
// How long a browser's SSE stream waits, with no block forwarded, for OpenCode to take it back.
const DEFAULT_SSE_RESUME_WINDOW_MS = 30_000;
const DEFAULT_SSE_RECONNECT_DELAY_MS = 250;
const DEFAULT_SSE_RECONNECT_MAX_DELAY_MS = 2_000;

const OPENCODE_AGENT_KEEP_ALIVE_MS = 30_000;
// Node's own default. A lower cap evicts pooled sockets under concurrency,
// which reintroduces exactly the per-request connection churn this agent
// exists to prevent (measured: at 64 concurrent requests, a cap of 32 left
// 303 sockets in TIME_WAIT versus 0 at 256).
const OPENCODE_AGENT_MAX_FREE_SOCKETS = 256;
// Evicts idle free sockets from our side before upstream servers close them
// (Node default keepAliveTimeout is 5s, Bun default idle timeout is 10s).
// Setting this higher than upstream causes stale socket reuse where the
// client writes into a dead socket and gets 'socket hang up' (ECONNRESET).
const OPENCODE_AGENT_IDLE_TIMEOUT_MS = 4_000;

// The session list/detail/message routes read the whole upstream body and
// parse it (the overlay and the message shelling need the parsed body), so the
// read is capped while it streams in: 16 MiB matches the event-stream
// protocol's in-memory bound for the same session/message data
// (MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES), and UI pages stay far below it
// (message pages ask for 10-50 messages, session lists for <=200 records).
export const SESSION_LIST_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

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

const formatProxyFailure = (req, handler, error, timedOut = false) => {
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req?.method) ? req.method : 'OTHER';
  let route = '/api/other';
  try {
    const mapped = diagnosticApiRoute(new URL(req?.originalUrl || req?.url, 'http://localhost').pathname);
    if (mapped !== '/other') route = mapped;
  } catch { /* Never use a malformed request URL as diagnostic text. */ }
  let failureClass = timedOut ? 'timeout' : 'error';
  let message = 'unavailable';
  let cause = null;
  try {
    if (!timedOut) failureClass = DIAGNOSTIC_PROXY_ERROR_CLASSES.get(error?.code) ?? DIAGNOSTIC_PROXY_ERROR_CLASSES.get(error?.cause?.code) ?? 'error';
    message = diagnosticErrorMessage(error?.message) ?? 'unavailable';
    cause = diagnosticErrorMessage(error?.cause?.message);
  } catch { /* Diagnostics must not prevent an upstream error response. */ }
  return `method=${method} route=${route} function=${handler} class=${failureClass} message="${message}"${cause && cause !== message ? ` cause="${cause}"` : ''}`;
};

const isHttpsProxyTarget = (target) => {
  if (typeof target !== 'string') {
    return false;
  }
  try {
    return new URL(target).protocol === 'https:';
  } catch {
    return /^https:/i.test(target.trim());
  }
};

/**
 * Agent for proxied OpenCode API requests.
 *
 * When no agent is supplied, `http-proxy` falls back to `agent: false`, which
 * both disables connection pooling and forces `Connection: close` on every
 * proxied request (http-proxy/lib/http-proxy/common.js). That consumes one
 * ephemeral port per request, and sustained traffic can exhaust the host's
 * ephemeral port range — after which every process on the machine fails to
 * open outbound connections with EADDRNOTAVAIL.
 *
 * The agent must match the target scheme: http-proxy dispatches through
 * `https.request` when `target.protocol === 'https:'`
 * (http-proxy/lib/http-proxy/passes/web-incoming.js), and an `http.Agent`
 * would open a plaintext socket to a TLS port. External servers may be
 * configured over https via `OPENCODE_HOST` (see env-config.js), so derive the
 * agent class from the resolved target.
 *
 * `maxSockets: Infinity` preserves the unbounded concurrency of `agent: false`,
 * so this changes connection reuse only, not request throughput.
 */
export const createOpenCodeProxyAgent = (target) => (
  isHttpsProxyTarget(target)
    ? new https.Agent(OPENCODE_AGENT_OPTIONS)
    : new http.Agent(OPENCODE_AGENT_OPTIONS)
);

/**
 * Lazily resolves the proxy agent, memoized per scheme.
 *
 * The scheme cannot be decided at registration time: `setupProxy()` runs before
 * `bootstrapOpenCodeAtStartup()` (startup-pipeline-runtime.js), so on a cold
 * start `state.openCodePort` is still null, `buildOpenCodeUrl()` throws
 * (network-runtime.js) and `resolveProxyTarget()` falls back to the http
 * loopback default. An external server configured over https via
 * `OPENCODE_HOST` only becomes visible on `state.openCodeBaseUrl` after
 * bootstrap completes.
 *
 * http-proxy-middleware rebuilds its per-request options with
 * `Object.assign({}, this.proxyOptions)` inside `prepareProxyRequest`, which
 * invokes getters, so exposing `agent` as a getter defers resolution to request
 * time. Memoizing per scheme keeps a single shared pool per scheme rather than
 * allocating an agent per request.
 */
const createOpenCodeProxyAgentResolver = (resolveTarget) => {
  const agents = new Map();

  return () => {
    const target = resolveTarget();
    const scheme = isHttpsProxyTarget(target) ? 'https:' : 'http:';
    let agent = agents.get(scheme);
    if (!agent) {
      // Construct through the shared factory rather than inline, so both
      // schemes are built from OPENCODE_AGENT_OPTIONS by the same code path.
      agent = createOpenCodeProxyAgent(target);
      agents.set(scheme, agent);
    }
    return agent;
  };
};

export const createDirectoryQueryCanonicalizer = ({ realpath, ...cacheOptions } = {}) => {
  const realpathCache = createRealpathCache({ fallbackOnError: true, realpath, ...cacheOptions });

  return async (requestUrl) => {
    if (typeof requestUrl !== 'string' || !requestUrl.includes('directory=')) {
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

// OpenCode decodes a percent-encoded directory header with or without the
// `uri` marker, and also reads `location[directory]`; a folder is matched the
// way OpenCode will read it.
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

const directoriesAsOpenCodeReadsThem = (req, url) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = req.get('x-opencode-directory');
  if (header) {
    let directory = header;
    if (req.get('x-opencode-directory-encoding') === 'uri' || PERCENT_ESCAPE.test(header)) {
      try {
        directory = decodeURIComponent(header);
      } catch {
        // OpenCode rejects a malformed value; nothing to match.
      }
    }
    directories.push(directory);
  }
  return directories;
};

export const normalizeForwardedDirectoryHeaders = (headers) => {
  const rawDirectory = headers?.['x-opencode-directory'];
  if (typeof rawDirectory !== 'string') {
    return headers;
  }

  if (headers['x-opencode-directory-encoding'] !== 'uri') {
    return headers;
  }

  try {
    headers['x-opencode-directory'] = decodeURIComponent(rawDirectory);
  } catch {
    // Leave malformed values untouched; upstream will reject invalid paths.
  }
  delete headers['x-opencode-directory-encoding'];
  return headers;
};

const waitForSseDrain = (res, signal) => new Promise((resolve) => {
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

export const writeSseChunkWithBackpressure = async (res, value, signal) => {
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

  const normalize = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    observe(value) {
      const text = typeof value === 'string'
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

/**
 * Fields a session list is allowed to carry to the browser.
 *
 * The list is an allowlist, not a blocklist: OpenCode keeps adding to
 * `SessionInfo`, and a session list is fetched constantly, so anything heavy
 * that appears later must not silently start crossing the wire. `revert.files`
 * and `revert.snapshot` are the expensive parts and are dropped below;
 * `permissions` is a per-session ruleset the list view never reads.
 */
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
];

export const sanitizeSessionListItem = (session) => {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return session;
  }

  const sanitized = {};
  for (const key of SESSION_LIST_ALLOWED_FIELDS) {
    if (key in session) {
      sanitized[key] = session[key];
    }
  }

  // Only the revert marker: the staged file list and its snapshot are what make
  // a reverted session's record large.
  const revert = session.revert;
  if (revert && typeof revert === 'object' && !Array.isArray(revert)) {
    const revertMarker = {};
    if (typeof revert.messageID === 'string') {
      revertMarker.messageID = revert.messageID;
    }
    if (typeof revert.partID === 'string') {
      revertMarker.partID = revert.partID;
    }
    if (Object.keys(revertMarker).length > 0) {
      sanitized.revert = revertMarker;
    }
  }

  return sanitized;
};

/**
 * Preserve the V2 pagination envelope while sanitizing session records.
 */
const sanitizeSessionListPayload = (payload) => {
  if (Array.isArray(payload)) {
    return payload.map((session) => sanitizeSessionListItem(session));
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.map((session) => sanitizeSessionListItem(session)) };
  }
  return payload;
};

const sessionListRecords = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) return payload.data;
  return null;
};

export const registerOpenCodeProxy = (app, deps) => {
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
    getSseUpstreamStallTimeoutMs = () => SSE_UPSTREAM_STALL_TIMEOUT_MS,
    SSE_RESUME_WINDOW_MS = DEFAULT_SSE_RESUME_WINDOW_MS,
    SSE_RECONNECT_DELAY_MS = DEFAULT_SSE_RECONNECT_DELAY_MS,
    SSE_RECONNECT_MAX_DELAY_MS = DEFAULT_SSE_RECONNECT_MAX_DELAY_MS,
    readWorktreeBootstrapStatus = getWorktreeBootstrapStatus,
    WORKTREE_READY_TIMEOUT_MS = 5 * 60 * 1000,
    waitForWorktreeRemovalToSettle = waitForWorktreeRemoval,
    WORKTREE_REMOVAL_HOLD_MS = 60 * 1000,
    // OpenCode 2.x has no archive route, so archive state is OpenChamber's own
    // and the proxy folds it onto the sessions it serves (`time.archived`).
    // Session metadata lives on OpenCode's record; the proxy lays over only
    // the entries an older OpenChamber left in the legacy file until they are
    // migrated.
    getArchivedSessions = null,
    getStoredSessionMetadata = null,
    // Isolated spaces, when the feature's switch is on: the merged session list, and the hub
    // whose space events the global SSE stream carries beside the host's. Both absent means
    // the host's own answers go out exactly as before spaces.
    mergeSpaceSessionList = null,
    spaceEventHub = null,
  } = deps;

  /**
   * `{ [sessionID]: archivedAt }` for the current instance, or `null` when the
   * store cannot answer. `null` means "unknown", and an unknown answer leaves
   * the upstream record untouched — never rewrites a session as un-archived.
   */
  const readArchivedSessions = async () => {
    if (typeof getArchivedSessions !== 'function') return null;
    try {
      const archived = await getArchivedSessions();
      return archived && typeof archived === 'object' ? archived : null;
    } catch (error) {
      console.warn('[proxy] archive state unavailable:', error?.message ?? error);
      return null;
    }
  };

  /**
   * `{ [sessionID]: metadata }` still waiting to be migrated to OpenCode, or
   * `null` when the store cannot answer. `null` means "unknown", and an
   * unknown answer leaves the upstream record untouched.
   */
  const readStoredSessionMetadata = async () => {
    if (typeof getStoredSessionMetadata !== 'function') return null;
    try {
      const stored = await getStoredSessionMetadata();
      // Nothing left to migrate is the normal state: skip the rewrite entirely.
      return stored && typeof stored === 'object' && Object.keys(stored).length > 0 ? stored : null;
    } catch (error) {
      console.warn('[proxy] session metadata unavailable:', error?.message ?? error);
      return null;
    }
  };

  // A number archives, `null` is an explicit unarchive (drops the stamp OpenCode
  // still carries for a session migrated from v1), and a session the file does
  // not mention keeps whatever OpenCode says.
  const withArchivedAt = (session, archived) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
    if (!Object.prototype.hasOwnProperty.call(archived, session.id)) return session;
    const archivedAt = archived[session.id];
    const time = session.time && typeof session.time === 'object' ? session.time : {};
    if (typeof archivedAt === 'number') {
      return { ...session, time: { ...time, archived: archivedAt } };
    }
    if (!('archived' in time)) return session;
    const { archived: _dropped, ...rest } = time;
    return { ...session, time: rest };
  };

  /**
   * A legacy entry is the newest metadata its session has, including {}, so it
   * replaces the upstream record until migration pushes it there.
   */
  const withStoredMetadata = (session, stored) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
    const ours = stored[session.id];
    if (!ours || typeof ours !== 'object' || Array.isArray(ours)) return session;
    return { ...session, metadata: ours };
  };

  const overlaySession = (session, archived, stored) => {
    let result = session;
    if (archived) result = withArchivedAt(result, archived);
    if (stored) result = withStoredMetadata(result, stored);
    return result;
  };

  const overlayOwnedStateOnList = async (payload) => {
    const records = sessionListRecords(payload);
    if (!records) return payload;
    const [archived, stored] = await Promise.all([readArchivedSessions(), readStoredSessionMetadata()]);
    if (!archived && !stored) return payload;
    const overlaid = records.map((session) => overlaySession(session, archived, stored));
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

  const isAbortError = (error) => error?.name === 'AbortError';
  const isResponseTooLargeError = (error) => error?.code === 'response_too_large';
  const FALLBACK_PROXY_TARGET = 'http://127.0.0.1:3902';
  const canonicalizeDirectoryQuery = createDirectoryQueryCanonicalizer({
    realpath: fs?.promises?.realpath?.bind(fs.promises),
  });

  const hasParsedBodyValue = (body) => {
    if (body === undefined || body === null) return false;
    if (Buffer.isBuffer(body)) return body.length > 0;
    if (typeof body === 'string') return body.length > 0;
    if (Array.isArray(body)) return body.length > 0;
    if (typeof body === 'object') return Object.keys(body).length > 0;
    return true;
  };

  const getContentType = (proxyReq, req) => {
    const value = proxyReq.getHeader?.('content-type') ?? req.headers?.['content-type'] ?? '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value || '');
  };

  const serializeUrlEncodedBody = (body) => {
    if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) {
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

  const serializeParsedBody = (req, proxyReq) => {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    if (req.body === undefined || req.body === null) return null;
    const originalContentLength = Number.parseInt(req.headers?.['content-length'] || '0', 10) || 0;
    if (!hasParsedBodyValue(req.body) && originalContentLength <= 0) return null;

    const contentType = getContentType(proxyReq, req).toLowerCase();
    if (Buffer.isBuffer(req.body)) return req.body;
    if (contentType.includes('application/json')) return Buffer.from(JSON.stringify(req.body));
    if (contentType.includes('application/x-www-form-urlencoded')) return Buffer.from(serializeUrlEncodedBody(req.body));
    if (typeof req.body === 'string') return Buffer.from(req.body);
    return null;
  };

  const replayParsedBody = (proxyReq, req) => {
    const body = serializeParsedBody(req, proxyReq);
    if (!body) {
      // DO NOT remove transfer-encoding from a stream without content-length:
      // Node then sends tunneled prompt bodies without framing, and OpenCode
      // reads an empty payload (#4576).
      if (proxyReq.getHeader('content-length') !== undefined) {
        proxyReq.removeHeader('transfer-encoding');
      }
      return;
    }
    // DO NOT keep the copied transfer-encoding alongside the replayed body's
    // content-length: OpenCode rejects requests with both headers (#4280).
    proxyReq.removeHeader('transfer-encoding');
    proxyReq.setHeader('content-length', String(body.length));
    proxyReq.write(body);
  };

  const normalizeProxyTarget = (candidate) => {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  };

  // Keep generic proxy requests on the same upstream base URL that health checks
  // and direct fetch helpers use. This avoids split-brain state where /health
  // succeeds against an external host but /api/* still proxies to 127.0.0.1.
  const resolveProxyTarget = () => {
    const runtimeState = getRuntime();

    // `buildOpenCodeUrl` throws while the port is unknown, and the port is
    // nulled on several runtime paths (health-check failure, failed restart),
    // not just cold start. Checking first keeps a degraded OpenCode from
    // making every proxied request pay for a thrown-and-caught exception.
    if (runtimeState.openCodePort) {
      try {
        const resolved = normalizeProxyTarget(buildOpenCodeUrl('/', ''));
        if (resolved) {
          return resolved;
        }
      } catch {
      }
    }

    const externalBase = normalizeProxyTarget(runtimeState.openCodeBaseUrl);
    if (externalBase) {
      return externalBase;
    }

    return FALLBACK_PROXY_TARGET;
  };

  const normalizeProxyTimeout = (value) => {
    return Number.isFinite(value) && value > 0 ? value : 4 * 60 * 1000;
  };

  const PROXY_REQUEST_TIMEOUT_MS = normalizeProxyTimeout(LONG_REQUEST_TIMEOUT_MS);
  const PROXY_TIMEOUT_MARKER = Symbol('openchamberProxyTimedOut');

  // OpenCode 2.x runs provider connection through `/api/integration/*`, whose
  // OAuth steps return immediately and are polled, so no route needs a deadline
  // longer than the ordinary one any more.

  const isProxyTimeoutError = (error) => {
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    return code === 'ETIMEDOUT'
      || code === 'ESOCKETTIMEDOUT'
      || message.includes('timeout')
      || message.includes('timed out');
  };

  const sendProxyErrorResponse = (res, statusCode) => {
    if (!res || res.headersSent || res.writableEnded || typeof res.status !== 'function') {
      return false;
    }
    res.status(statusCode).json({ error: statusCode === 504 ? 'OpenCode upstream timed out' : 'OpenCode service unavailable' });
    return true;
  };

  const applyProxyResponseDeadline = (req, res, next) => {
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

  // A browser's stream outlives any one OpenCode connection. When OpenCode ends its stream cleanly
  // or the connection fails, the proxy keeps the browser's response open and reconnects with
  // Last-Event-ID set to the last id it forwarded, so OpenCode resumes from there, or answers with
  // a resync frame, which passes through like any other block. A stall still ends the stream, as
  // it always has, and so does a stretch with no forwarded block longer than the resume window:
  // the browser's own reconnect then takes over with the same cursor.
  const forwardSseRequest = async (req, res) => {
    const abortController = new AbortController();
    const closeUpstream = () => abortController.abort();
    let upstream = null;
    let reader = null;
    let heartbeatTimer = null;
    let upstreamStallTimer = null;
    let didUpstreamStall = false;
    let unsubscribeSpaceEvents = null;
    let writeQueue = Promise.resolve(true);
    let sseBoundary = createSseBoundaryTracker();

    req.on('close', closeUpstream);

    try {
      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');
      const upstreamPath = requestUrl;
      const headers = normalizeForwardedDirectoryHeaders(
        collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders())
      );
      headers.accept ??= 'text/event-stream';
      headers['cache-control'] ??= 'no-cache';
      // The cursor starts at the id the browser already holds, so a reconnect here resumes from it.
      const cursor = createSseCursor(String(req.headers['last-event-id'] ?? '').trim());

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
        // The upstream answered the event route with a non-SSE body (a JSON
        // error payload, a misconfigured server's page). Stream it through
        // with backpressure: the old `await upstream.text()` buffered the
        // whole body before sending anything, so a large or never-ending
        // body pinned the request, held the status and headers back, and
        // grew memory without bound (#759). The SSE stall window bounds
        // silence on this branch too: a body that goes quiet for that long
        // aborts the upstream, and the response ends with the bytes that
        // already streamed, so the client sees the truncation.
        res.flushHeaders?.();
        const nonSseReader = upstream.body.getReader();
        let nonSseStallTimer = null;
        const armNonSseStallTimer = () => {
          clearTimeout(nonSseStallTimer);
          nonSseStallTimer = setTimeout(() => {
            abortController.abort();
          }, getSseUpstreamStallTimeoutMs());
          nonSseStallTimer.unref?.();
        };
        try {
          armNonSseStallTimer();
          for (;;) {
            const { done, value } = await nonSseReader.read();
            if (done) {
              break;
            }
            if (value && value.length > 0) {
              armNonSseStallTimer();
              if (!await writeSseChunkWithBackpressure(res, value, abortController.signal)) {
                break;
              }
            }
          }
        } catch {
          // A stall abort or a reset upstream ends the response here with
          // the bytes already streamed.
        } finally {
          clearTimeout(nonSseStallTimer);
          try {
            nonSseReader.releaseLock();
          } catch {
          }
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }

      res.setHeader('Content-Type', contentType);
      // `no-transform` keeps proxies and tunnels (Cloudflare among them) from
      // compressing or buffering the stream, as the other SSE routes do.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      // Disable TCP Nagle's algorithm so small SSE chunks are sent immediately
      // instead of being buffered up to ~200ms by the TCP stack.
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
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
        clearTimeout(upstreamStallTimer);
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

      const enqueueSseWrite = (value) => {
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

      // The events of isolated spaces ride the global stream too, one block each, written
      // only between the upstream's own blocks so a block of the host's is never cut.
      // A directory in the query or in the header scopes the stream to the host's one directory.
      const isGlobalStream = !new URL(requestUrl, 'http://localhost').searchParams.get('directory') && !req.get('x-opencode-directory');
      const pendingSpaceBlocks = [];
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

      let resumeFailures = 0;
      let progressAt = Date.now();

      // Writes one upstream connection through to the browser until it ends. Returns 'ended' when
      // OpenCode closed its side between two blocks, 'cut' when it closed in the middle of one (the
      // bytes of that block already went out, so the browser stream has to end here), or 'closed'
      // when the browser is gone or the stream was aborted.
      const pumpUpstream = async (response) => {
        sseBoundary = createSseBoundaryTracker();
        const decoder = new TextDecoder();
        reader = response.body.getReader();
        resetUpstreamStallTimer();
        try {
          while (!abortController.signal.aborted) {
            let read;
            try {
              read = await reader.read();
            } catch (error) {
              // A reset socket reads as an error. Only an abort (the browser left, or the stall
              // timer gave up) is not a reason to reconnect.
              if (abortController.signal.aborted) throw error;
              return sseBoundary.isAtBoundary() ? 'ended' : 'cut';
            }
            const { done, value } = read;
            if (done) {
              return sseBoundary.isAtBoundary() ? 'ended' : 'cut';
            }
            if (value && value.length > 0) {
              resetUpstreamStallTimer();
              sseBoundary.observe(value);
              if (cursor.observe(decoder.decode(value, { stream: true })).length > 0) {
                progressAt = Date.now();
                resumeFailures = 0;
              }
              const canContinue = await enqueueSseWrite(value);
              if (!canContinue) {
                return 'closed';
              }
              if (!await flushSpaceBlocks()) {
                return 'closed';
              }
            }
          }
          return 'closed';
        } finally {
          clearUpstreamStallTimer();
        }
      };

      // Re-dials OpenCode for the browser's stream, from the cursor. Null when that attempt failed.
      const reconnectUpstream = async () => {
        const resumeHeaders = { ...headers };
        const lastEventId = cursor.lastEventId();
        if (lastEventId) {
          resumeHeaders['last-event-id'] = lastEventId;
        } else {
          delete resumeHeaders['last-event-id'];
        }
        try {
          const response = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
            method: 'GET',
            headers: resumeHeaders,
            signal: abortController.signal,
          });
          if (response.ok && response.body) {
            return response;
          }
          await response.body?.cancel().catch(() => {});
          return null;
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          return null;
        }
      };

      const waitBeforeReconnect = () => new Promise((resolve) => {
        const delay = Math.min(
          SSE_RECONNECT_DELAY_MS * 2 ** Math.min(resumeFailures, 10),
          SSE_RECONNECT_MAX_DELAY_MS,
        );
        const finish = () => {
          clearTimeout(timer);
          abortController.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        abortController.signal.addEventListener('abort', finish, { once: true });
      });

      let response = upstream;
      for (;;) {
        const outcome = await pumpUpstream(response);
        if (outcome !== 'ended') break;
        response = null;
        while (!response && !abortController.signal.aborted) {
          if (Date.now() - progressAt > SSE_RESUME_WINDOW_MS) break;
          await waitBeforeReconnect();
          if (abortController.signal.aborted) break;
          resumeFailures += 1;
          response = await reconnectUpstream();
        }
        if (!response) break;
        upstream = response;
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
      }
    }
  };

  const fetchSessionListPayload = async (upstreamPath, { req = null, timeoutMs = null } = {}) => {
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
      // The whole body is read and parsed below, so this fetch cannot
      // stream the way the event route's non-SSE branch does (#759). It is
      // bounded in time — a caller with no tighter budget gets the proxy's
      // long-request deadline, the same one the response deadline
      // middleware applies to the route — and in size, by the bounded read
      // below (#776).
      signal: AbortSignal.timeout(typeof timeoutMs === 'number' ? timeoutMs : PROXY_REQUEST_TIMEOUT_MS),
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const bounded = await readBoundedResponseText(upstream, SESSION_LIST_PAYLOAD_MAX_BYTES);
    if (bounded.tooLarge) {
      throw Object.assign(
        new Error(`OpenCode session payload exceeded ${SESSION_LIST_PAYLOAD_MAX_BYTES} bytes`),
        { code: 'response_too_large' },
      );
    }
    // Response.text() (the previous read) strips a leading UTF-8 BOM; the
    // bounded reader does not, so strip it here to keep the bytes the
    // callers see unchanged.
    const bodyText = bounded.text.replace(/^\uFEFF/, '');
    const isJson = contentType.toLowerCase().includes('application/json');

    if (!isJson) {
      return { upstream, contentType, bodyText, payload: null, isJson: false };
    }

    try {
      const payload = JSON.parse(bodyText);
      return { upstream, contentType, bodyText, payload, isJson: true, parseError: null };
    } catch (parseError) {
      return { upstream, contentType, bodyText, payload: null, isJson: true, parseError };
    }
  };

  const getRequestUpstreamPath = async (req) => {
    const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
      ? req.originalUrl
      : (typeof req.url === 'string' ? req.url : '');
    // OpenCode 2.x serves everything under `/api/*` itself, so the upstream
    // path is the request path — nothing is stripped.
    return canonicalizeDirectoryQuery(requestUrl);
  };

  const forwardSanitizedSessionListRequest = async (req, res, next) => {
    try {
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req });

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
      const hostList = await overlayOwnedStateOnList(sanitizeSessionListPayload(result.payload));
      // The first page of the global list carries every space's sessions after the host's; a
      // later page, and a list scoped to one directory, are the host's alone.
      const listQuery = new URL(upstreamPath, 'http://localhost').searchParams;
      const scopedToDirectory = Boolean(listQuery.get('directory') || req.get('x-opencode-directory'));
      const wantsSpaces = typeof mergeSpaceSessionList === 'function' && !listQuery.get('cursor') && !scopedToDirectory;
      res.json(wantsSpaces ? await mergeSpaceSessionList(hostList) : hostList);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (isResponseTooLargeError(error)) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'OpenCode response too large' });
          return;
        }
        next(error);
        return;
      }
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardSanitizedSessionListRequest', error)}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  };

  // Ensure API prefix is detected before proxying
  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  // Readiness gate — while OpenCode is starting/restarting, HOLD the request and
  // poll readiness instead of returning 503 immediately. A bare 503 pushes the
  // client into an exponential-backoff retry loop (500ms → 1s → …) that wastes
  // seconds of cold-start time and can fail bootstrap outright. Holding the
  // request until OpenCode is ready (typically well under a second) lets the
  // first call simply succeed. We still 503 if readiness doesn't arrive within a
  // bounded window so genuinely-down servers fail fast.
  const READINESS_HOLD_POLL_MS = 75;
  const READINESS_HOLD_MAX_MS = 6000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isStillWaiting = (runtimeState) => {
    const waitElapsed = runtimeState.openCodeNotReadySince === 0 ? 0 : Date.now() - runtimeState.openCodeNotReadySince;
    return (
      (!runtimeState.isOpenCodeReady && (runtimeState.openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      runtimeState.isRestartingOpenCode ||
      !runtimeState.openCodePort
    );
  };
  const classifyReadinessRoute = (requestPath) => {
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
      // Client gave up (closed/aborted) — stop holding.
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

  // A request for a folder of a worktree being removed would start that folder
  // again in OpenCode, local MCP servers included, and on Windows their working
  // directory keeps the folder from being deleted. It waits for the removal;
  // once the folder is gone OpenCode answers it without starting anything.
  app.use('/api', async (req, _res, next) => {
    const named = directoriesAsOpenCodeReadsThem(req, new URL(req.url, 'http://localhost'));
    if (named.length === 0) return next();
    let holdTimer;
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

  // Any directory-scoped read can initialize OpenCode's cached project/config,
  // before session.create runs. Hold all upstream requests until Git population
  // finishes, independently of the user's optional setup-script wait.
  app.use('/api', async (req, res, next) => {
    normalizeForwardedDirectoryHeaders(req.headers);
    const url = new URL(req.url, 'http://localhost');
    const directory = url.searchParams.get('directory') || req.get('x-opencode-directory');
    if (!directory) return next();

    const deadline = Date.now() + WORKTREE_READY_TIMEOUT_MS;
    try {
      while (!res.destroyed && !res.writableEnded && !req.aborted) {
        const status = await readWorktreeBootstrapStatus(directory);
        if (res.destroyed || res.writableEnded || req.aborted) return;
        if (status.status === 'failed') {
          return res.status(503).json({ error: status.error || 'Worktree bootstrap failed' });
        }
        if (status.status === 'ready' || status.phase === 'git-ready' || status.phase === 'setup-ready') {
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

  // V2 lists sessions across directories on every platform and owns pagination.
  app.get('/api/session', (req, res, next) => {
    return forwardSanitizedSessionListRequest(req, res, next);
  });

  // One session: the same overlay, so a detail read agrees with the list it
  // came from. Everything else about the record is forwarded untouched.
  app.get('/api/session/:sessionID', async function forwardSessionGetRequest(req, res, next) {
    if (typeof getArchivedSessions !== 'function' && typeof getStoredSessionMetadata !== 'function') return next();
    try {
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req });

      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.setHeader('content-type', result.contentType);

      const record = result.isJson && !result.parseError ? result.payload : null;
      const session = record && typeof record === 'object' && !Array.isArray(record)
        ? (record.data && typeof record.data === 'object' ? record.data : record)
        : null;
      if (!session || typeof session.id !== 'string') {
        res.end(result.bodyText);
        return;
      }

      const [archived, stored] = await Promise.all([readArchivedSessions(), readStoredSessionMetadata()]);
      if (!archived && !stored) {
        res.end(result.bodyText);
        return;
      }

      const overlaid = overlaySession(session, archived, stored);
      res.json(record.data && typeof record.data === 'object' ? { ...record, data: overlaid } : overlaid);
    } catch (error) {
      if (isAbortError(error)) return;
      if (isResponseTooLargeError(error)) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'OpenCode response too large' });
          return;
        }
        next(error);
        return;
      }
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardSessionGetRequest', error)}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  });

  // A client that asks for it gets message pages with finished tool results
  // shelled (see message-shells.js); anyone else reaches OpenCode untouched.
  app.get('/api/session/:sessionID/message', async function forwardMessageListRequest(req, res, next) {
    const keepWhole = parsePartShellsHeader(req.get(PART_SHELLS_HEADER));
    if (!keepWhole) return next();
    try {
      const upstreamPath = await getRequestUpstreamPath(req);
      const result = await fetchSessionListPayload(upstreamPath, { req });
      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.setHeader('content-type', result.contentType);
      if (!result.isJson || result.parseError || !result.upstream.ok) {
        res.end(result.bodyText);
        return;
      }
      res.json(shellMessagePage(result.payload, keepWhole));
    } catch (error) {
      if (isAbortError(error)) return;
      if (isResponseTooLargeError(error)) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'OpenCode response too large' });
          return;
        }
        next(error);
        return;
      }
      console.error(`[proxy] OpenCode proxy error: ${formatProxyFailure(req, 'forwardMessageListRequest', error)}`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
        return;
      }
      next(error);
    }
  });

  // v2 has one event stream. `/api/global/event` stays as an alias so a client
  // that has not reloaded yet keeps working; both reach upstream `/api/event`.
  app.get('/api/global/event', (req, res, next) => {
    req.url = req.url.replace('/api/global/event', '/api/event');
    if (typeof req.originalUrl === 'string') {
      req.originalUrl = req.originalUrl.replace('/api/global/event', '/api/event');
    }
    return forwardSseRequest(req, res, next);
  });
  app.get('/api/event', forwardSseRequest);

  // Generic proxy for non-SSE OpenCode API routes.
  // The agent is exposed as a getter so its class is resolved per request, not
  // at registration: the proxy is registered before OpenCode bootstraps, so an
  // https target configured via OPENCODE_HOST is not yet visible here. Agents
  // are memoized per scheme, so this is still one shared pool per scheme across
  // `apiProxy`.
  const resolveOpenCodeProxyAgent = createOpenCodeProxyAgentResolver(resolveProxyTarget);

  const createApiProxy = (timeoutMs) => createProxyMiddleware({
    target: resolveProxyTarget(),
    get agent() {
      return resolveOpenCodeProxyAgent();
    },
    changeOrigin: true,
    timeout: timeoutMs,
    proxyTimeout: timeoutMs,
    // The proxy is mounted on `/api`, so Express has already stripped that
    // prefix by the time the middleware sees the request. OpenCode 2.x serves
    // everything under `/api/*` itself, so put it back.
    pathRewrite: (proxiedPath) => `/api${proxiedPath === '/' ? '' : proxiedPath}`,
    // Dynamic target — port can change after restart
    router: () => resolveProxyTarget(),
    on: {
      proxyReq: (proxyReq, req, res) => {
        // A replaced OpenCode drains until no request still answers from its port.
        const endUpstreamRequest = beginUpstreamRequest(Number(new URL(resolveProxyTarget()).port));
        res?.once('close', endUpstreamRequest);
        // Inject OpenCode auth headers
        const authHeaders = getOpenCodeAuthHeaders();
        if (authHeaders.Authorization) {
          proxyReq.setHeader('Authorization', authHeaders.Authorization);
        }

        if (req.headers?.['x-opencode-directory-encoding'] === 'uri') {
          const rawDirectory = req.headers['x-opencode-directory'];
          if (typeof rawDirectory === 'string') {
            try {
              proxyReq.setHeader('x-opencode-directory', decodeURIComponent(rawDirectory));
            } catch {
              proxyReq.setHeader('x-opencode-directory', rawDirectory);
            }
          }
          proxyReq.removeHeader?.('x-opencode-directory-encoding');
        }

        // Defensive: request identity encoding from upstream OpenCode.
        // This avoids compressed-body/header mismatches in multi-proxy setups.
        proxyReq.setHeader('accept-encoding', 'identity');

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
          res?.socket?.destroyed
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

  // Best-effort fallback for stale clients still sending symlink paths.
  // Settings and project selection normalize at source; this cached async path
  // avoids blocking the proxy hot path on every directory-scoped request.
  app.use('/api', async (req, _res, next) => {
    try {
      const rewrittenUrl = await canonicalizeDirectoryQuery(req.url);
      if (rewrittenUrl !== req.url) {
        req.url = rewrittenUrl;
      }
    } catch {
      // Pass through as-is if URL parsing or realpath resolution fails.
    }
    next();
  });

  app.use('/api', applyProxyResponseDeadline);
  // v1's interactive provider/MCP OAuth callbacks are gone: v2 runs provider
  // connection through `/api/integration/*`, which answers immediately and
  // needs no special deadline.
  app.use('/api', apiProxy);
};
