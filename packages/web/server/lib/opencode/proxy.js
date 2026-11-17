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
import { recordStartupPerformance } from './startup-performance.js';
import { getWorktreeBootstrapStatus, waitForWorktreeRemoval } from '../git/service.js';
import { PART_SHELLS_HEADER, parsePartShellsHeader, shellMessagePage } from './message-shells.js';
import { diagnosticApiRoute, diagnosticErrorMessage } from '../diagnostics/vocabulary.js';
import { withUnreadBaseline } from '../openchamber-sessions/unread-baseline.js';
import { OPENCODE_TRUST_ROUTE, isGlobalRead, readMoveDestination, sessionMoveOf } from '../opencode-trust/index.js';
import { createSessionDirectoryResolver } from '../opencode-trust/session-directory.js';

export const createUpstreamReadSignal = ({ res = null, timeoutMs }) => {
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

// external: https://github.com/http-party/node-http-proxy/blob/master/lib/http-proxy/common.js Without an agent, http-proxy disables pooling and forces Connection: close.
export const createOpenCodeProxyAgent = (target) => (
  isHttpsProxyTarget(target)
    ? new https.Agent(OPENCODE_AGENT_OPTIONS)
    : new http.Agent(OPENCODE_AGENT_OPTIONS)
);

export const applyOwnedArchiveState = (session, archivedById) => {
  if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
  if (!archivedById || !Object.prototype.hasOwnProperty.call(archivedById, session.id)) return session;
  const archivedAt = archivedById[session.id];
  const time = session.time && typeof session.time === 'object' ? session.time : {};
  if (typeof archivedAt === 'number') return { ...session, time: { ...time, archived: archivedAt } };
  if (!('archived' in time)) return session;
  const { archived: _dropped, ...rest } = time;
  return { ...session, time: rest };
};

// external: https://github.com/chimurai/http-proxy-middleware/blob/master/src/http-proxy-middleware.ts Per-request option copying invokes the agent getter after the target becomes known.
const createOpenCodeProxyAgentResolver = (resolveTarget) => {
  const agents = new Map();

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
        // OpenCode falls back to the raw header if decoding fails.
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
    const decodedDirectory = decodeURIComponent(rawDirectory);
    try {
      http.validateHeaderValue('x-opencode-directory', decodedDirectory);
    } catch {
      return headers;
    }
    headers['x-opencode-directory'] = decodedDirectory;
  } catch {
    // OpenCode falls back to the raw value when URI decoding fails.
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

const RETIRED_SESSION_METADATA_KEYS = ['knowledge_context_delivered'];

const withoutRetiredMetadataKeys = (metadata) => {
  const openchamber = metadata?.openchamber;
  if (!openchamber || typeof openchamber !== 'object' || !RETIRED_SESSION_METADATA_KEYS.some((key) => key in openchamber)) return metadata;
  const kept = { ...openchamber };
  for (const key of RETIRED_SESSION_METADATA_KEYS) delete kept[key];
  return { ...metadata, openchamber: kept };
};

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

  if ('metadata' in sanitized) sanitized.metadata = withoutRetiredMetadataKeys(sanitized.metadata);

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
    if (typeof getArchivedSessions !== 'function') return null;
    try {
      const archived = await getArchivedSessions();
      return archived && typeof archived === 'object' ? archived : null;
    } catch (error) {
      console.warn('[proxy] archive state unavailable:', error?.message ?? error);
      return null;
    }
  };

  const readStoredSessionMetadata = async () => {
    if (typeof getStoredSessionMetadata !== 'function') return null;
    try {
      const stored = await getStoredSessionMetadata();
      return stored && typeof stored === 'object' && Object.keys(stored).length > 0 ? stored : null;
    } catch (error) {
      console.warn('[proxy] session metadata unavailable:', error?.message ?? error);
      return null;
    }
  };

  const readUnreadBaseline = async () => {
    if (!getUnreadBaseline) return null;
    try {
      const since = await getUnreadBaseline();
      return Number.isSafeInteger(since) ? since : null;
    } catch (error) {
      console.warn('[proxy] unread baseline unavailable:', error?.message ?? error);
      return null;
    }
  };

  const withStoredMetadata = (session, stored) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string') return session;
    const ours = stored[session.id];
    if (!ours || typeof ours !== 'object' || Array.isArray(ours)) return session;
    return { ...session, metadata: withoutRetiredMetadataKeys(ours) };
  };

  const overlaySession = (session, { archived, stored, unreadSince }) => {
    let result = session;
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

  const hasOwnedState = ({ archived, stored, unreadSince }) => Boolean(archived || stored || unreadSince !== null);

  const overlayOwnedStateOnList = async (payload) => {
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
        const result = await openCodeTrust.handleRoute({ method: req.method, query: req.query, body: req.body });
        res.setHeader('Cache-Control', 'no-store');
        res.status(result.status).json(result.body);
      } catch (error) {
        console.error('[proxy] OpenCode trust check failed:', error?.message ?? error);
        res.status(500).json({ error: 'Failed to check the folder configuration' });
      }
    });
  }

  const isAbortError = (error) => error?.name === 'AbortError';
  const sessionRouteErrorStatus = (error) => {
    if (isAbortError(error)) return null;
    return isProxyTimeoutError(error) ? 504 : 503;
  };
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
      if (proxyReq.getHeader('content-length') !== undefined) {
        proxyReq.removeHeader('transfer-encoding');
      }
      return;
    }
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

  const resolveProxyTarget = () => {
    const runtimeState = getRuntime();

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
    return Number.isFinite(value) && value >= 0 ? value : 4 * 60 * 1000;
  };

  const PROXY_REQUEST_TIMEOUT_MS = normalizeProxyTimeout(LONG_REQUEST_TIMEOUT_MS);
  const SESSION_UPSTREAM_TIMEOUT_MS = sessionUpstreamTimeoutOverrideMs ?? PROXY_REQUEST_TIMEOUT_MS;
  const PROXY_TIMEOUT_MARKER = Symbol('openchamberProxyTimedOut');


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
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

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

  const fetchSessionListPayload = async (upstreamPath, { req = null, signal = null, timeoutMs = SESSION_UPSTREAM_TIMEOUT_MS } = {}) => {
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
    return canonicalizeDirectoryQuery(requestUrl);
  };

  const forwardSanitizedSessionListRequest = async (req, res, next) => {
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
      const wantsSpaces = typeof mergeSpaceSessionList === 'function' && !listQuery.get('cursor') && !scopedToDirectory;
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

  const resolveSessionDirectory = createSessionDirectoryResolver({ fetchImpl: fetch, buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const parseJsonBody = express.json({ limit: '64kb' });
  const readBody = (req, res) => new Promise((resolve, reject) => {
    parseJsonBody(req, res, (error) => (error ? reject(error) : resolve(req.body)));
  });

  const checkoutGateFolders = async (req, res, url) => {
    const folders = directoriesAsOpenCodeReadsThem(req, url).filter(Boolean);
    const movedSessionID = sessionMoveOf(req.method, new URL(req.originalUrl || req.url, 'http://localhost').pathname);
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
          if (isGlobalRead(req.method, pathname)) return next();
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
          method: req.method,
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
      typeof getArchivedSessions !== 'function'
      && typeof getStoredSessionMetadata !== 'function'
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
      const session = record && typeof record === 'object' && !Array.isArray(record)
        ? (record.data && typeof record.data === 'object' ? record.data : record)
        : null;
      if (!session || typeof session.id !== 'string') {
        res.end(result.bodyText);
        return;
      }

      const owned = await readOwnedState();
      if (!hasOwnedState(owned)) {
        res.end(result.bodyText);
        return;
      }

      const overlaid = overlaySession(session, owned);
      res.json(record.data && typeof record.data === 'object' ? { ...record, data: overlaid } : overlaid);
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

  app.get('/api/global/event', (req, res, next) => {
    req.url = req.url.replace('/api/global/event', '/api/event');
    if (typeof req.originalUrl === 'string') {
      req.originalUrl = req.originalUrl.replace('/api/global/event', '/api/event');
    }
    return forwardSseRequest(req, res, next);
  });
  app.get('/api/event', forwardSseRequest);

  const resolveOpenCodeProxyAgent = createOpenCodeProxyAgentResolver(resolveProxyTarget);

  const createApiProxy = (timeoutMs) => createProxyMiddleware({
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
  mcpOAuthSignIn?.registerStartRoutes(app, { readBody });
  app.use('/api', apiProxy);
};
