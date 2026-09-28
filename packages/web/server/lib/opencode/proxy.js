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
import { recordStartupPerformance } from './startup-performance.js';
import { getWorktreeBootstrapStatus } from '../git/service.js';

const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

const OPENCODE_AGENT_KEEP_ALIVE_MS = 30_000;
// Node's own default. A lower cap evicts pooled sockets under concurrency,
// which reintroduces exactly the per-request connection churn this agent
// exists to prevent (measured: at 64 concurrent requests, a cap of 32 left
// 303 sockets in TIME_WAIT versus 0 at 256).
const OPENCODE_AGENT_MAX_FREE_SOCKETS = 256;
// Evicts idle free sockets from our side. Without it the only thing that
// retires an idle pooled socket is the upstream closing it. Note this is
// distinct from `keepAliveMsecs`, which is the TCP keep-alive probe delay.
const OPENCODE_AGENT_IDLE_TIMEOUT_MS = 60_000;

const OPENCODE_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: OPENCODE_AGENT_KEEP_ALIVE_MS,
  maxSockets: Infinity,
  maxFreeSockets: OPENCODE_AGENT_MAX_FREE_SOCKETS,
  timeout: OPENCODE_AGENT_IDLE_TIMEOUT_MS,
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
    readWorktreeBootstrapStatus = getWorktreeBootstrapStatus,
    WORKTREE_READY_TIMEOUT_MS = 5 * 60 * 1000,
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
    if (!body) return;
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
    const sseBoundary = createSseBoundaryTracker();

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
      res.setHeader('Cache-Control', 'no-cache');
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
      console.error('[proxy] OpenCode SSE proxy error:', error?.message ?? error);
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
      ...(typeof timeoutMs === 'number' ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const bodyText = await upstream.text();
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

  const forwardSanitizedSessionListRequest = async (req, res, next, logLabel) => {
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
      console.error(`[proxy] OpenCode ${logLabel} proxy error:`, error?.message ?? error);
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
    return forwardSanitizedSessionListRequest(req, res, next, 'session.list');
  });

  // One session: the same overlay, so a detail read agrees with the list it
  // came from. Everything else about the record is forwarded untouched.
  app.get('/api/session/:sessionID', async (req, res, next) => {
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
      console.error('[proxy] OpenCode session.get proxy error:', error?.message ?? error);
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
      proxyReq: (proxyReq, req) => {
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
      error: (err, req, res) => {
        console.error('[proxy] OpenCode proxy error:', err.message);
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
