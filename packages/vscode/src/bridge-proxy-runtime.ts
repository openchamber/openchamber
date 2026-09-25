import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';
import { isSessionRecordPath, overlaySessionResponseBody, parseJson, type SessionStateStore } from './openchamberSessionState';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ApiProxyRequestPayload = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type ApiSessionMessageRequestPayload = {
  path?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type ApiProxyAbortPayload = {
  requestID?: string;
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  bodyText?: string;
};

const shouldReturnTextBody = (headers: Headers): boolean => {
  const contentType = headers.get('content-type')?.toLowerCase() || '';
  return contentType.startsWith('application/json')
    || contentType.startsWith('text/')
    || contentType.includes('+json');
};

const collectProxyResponseHeaders = (headers: Headers, deps: Pick<ProxyRuntimeDeps, 'collectHeaders'>): Record<string, string> => {
  const result = deps.collectHeaders(headers);
  delete result['content-length'];
  delete result['content-encoding'];
  delete result['transfer-encoding'];
  return result;
};

// OpenCode 2.x has one event stream, `GET /api/event`.
const isSseProxyPath = (requestPath: string): boolean => {
  try {
    return new URL(requestPath, 'https://openchamber.invalid').pathname === '/api/event';
  } catch {
    return requestPath === '/api/event';
  }
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  /** Archive flags and stored metadata to fold onto session reads; optional for callers without owned state. */
  sessionState?: Pick<SessionStateStore, 'readArchived' | 'readMetadata'>;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
};

const proxyAbortControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// In-flight read coalescing (parity with the web runtimeFetch coalescer)
//
// On cold start the webview's two data layers — the sync bootstrap and the
// config store — fire the SAME idempotent reads (config, location, agent,
// project, command, model, provider) concurrently through the bridge with no
// shared dedup. That
// saturates the single OpenCode process and delays everything queued behind it
// (e.g. createSession). Coalesce genuinely-concurrent identical GETs to those
// read endpoints so OpenCode does the work once; every caller gets its own
// response payload copy.
//
// Scope is deliberately tight: GET only, an allowlist of read paths. The shared
// fetch runs without a per-request AbortController, so one caller's
// `api:proxy:abort` cannot cancel the read for the others (these reads are fast
// and idempotent — losing abort for them is harmless). The entry is removed as
// soon as the request settles, so this only ever shares overlapping in-flight
// requests; it never serves a stale response.
// ---------------------------------------------------------------------------
const COALESCE_READ_PATH = /^\/api\/(config|location|agent|project|command|model|provider)(\b|\/|\?|$)/;
const READ_COALESCE = new Map<string, Promise<ApiProxyResponsePayload>>();

// Two reads are "identical" only when everything OpenCode sees is identical.
// On OpenCode 2.x the project directory travels in the `x-opencode-directory`
// header, not the URL, and the auth headers pick the upstream scope; keying on
// the URL alone would answer project B's `/api/config` with project A's body.
// Every forwarded header therefore joins the key, canonicalized so header-name
// casing cannot split otherwise-identical reads.
const buildReadCoalesceKey = (targetUrl: string, headers: Record<string, string>): string => {
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => `${name.toLowerCase()}=${value}`)
    .sort()
    .join('\n');
  return `GET ${targetUrl}\n${canonicalHeaders}`;
};

const performApiProxyFetch = async (
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
  deps: Pick<ProxyRuntimeDeps, 'collectHeaders'>,
): Promise<ApiProxyResponsePayload> => {
  try {
    const response = await fetch(targetUrl, { method, headers, body, signal });
    const responseHeaders = collectProxyResponseHeaders(response.headers, deps);
    if (shouldReturnTextBody(response.headers)) {
      return { status: response.status, headers: responseHeaders, bodyText: await response.text() };
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      headers: responseHeaders,
      bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
    };
  } catch (error) {
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
      }),
    };
  }
};

/**
 * `GET /api/session` and `GET /api/session/:id` come back with OpenChamber's
 * own archive flag and metadata folded in, the same as the web proxy does, so
 * the shared UI keeps reading `time.archived` and `metadata` where it always
 * did. A file that cannot be read leaves the upstream record untouched.
 */
const overlayOwnedSessionState = async (
  method: string,
  requestPath: string,
  data: ApiProxyResponsePayload,
  sessionState: ProxyRuntimeDeps['sessionState'],
): Promise<ApiProxyResponsePayload> => {
  if (!sessionState || method !== 'GET' || data.status !== 200 || typeof data.bodyText !== 'string') return data;
  let pathname: string;
  try {
    pathname = new URL(requestPath, 'https://openchamber.invalid').pathname;
  } catch {
    return data;
  }
  if (!isSessionRecordPath(pathname)) return data;
  const body = parseJson(data.bodyText);
  if (body === null) return data;
  const [archived, stored] = await Promise.all([sessionState.readArchived(), sessionState.readMetadata()]);
  if (!archived && !stored) return data;
  return { ...data, bodyText: JSON.stringify(overlaySessionResponseBody(body, archived, stored)) };
};

export async function handleProxyBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:proxy:abort': {
      const { requestID } = (payload || {}) as ApiProxyAbortPayload;
      if (typeof requestID === 'string' && requestID.length > 0) {
        proxyAbortControllers.get(requestID)?.abort();
        proxyAbortControllers.delete(requestID);
      }
      return { id, type, success: true, data: { aborted: true } };
    }

    case 'api:proxy': {
      const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
          : `/${requestPath.trim()}`
          : '/';

      if (isSseProxyPath(normalizedPath)) {
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'SSE requests must use api:sse:start' }),
        };
        return { id, type, success: true, data };
      }

      const localFsResponse = await deps.tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
      if (localFsResponse) {
        return { id, type, success: true, data: localFsResponse };
      }

      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      const requestBody =
        typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
          ? Buffer.from(bodyBase64, 'base64')
          : undefined;

      // Coalesce concurrent identical GET reads to idempotent endpoints so the
      // single OpenCode process serves them once. The shared fetch carries no
      // AbortController (api:proxy:abort can't cancel these reads), so one
      // caller aborting can't strand the others.
      const coalesceKey =
        normalizedMethod === 'GET' && COALESCE_READ_PATH.test(normalizedPath)
          ? buildReadCoalesceKey(targetUrl, requestHeaders)
          : null;
      if (coalesceKey) {
        const existing = READ_COALESCE.get(coalesceKey);
        if (existing) {
          const shared = await existing;
          return { id, type, success: true, data: { ...shared, headers: { ...shared.headers } } };
        }
        const pending = performApiProxyFetch(targetUrl, 'GET', requestHeaders, undefined, undefined, deps);
        READ_COALESCE.set(coalesceKey, pending);
        pending.then(
          () => READ_COALESCE.delete(coalesceKey),
          () => READ_COALESCE.delete(coalesceKey),
        );
        const data = await overlayOwnedSessionState('GET', normalizedPath, await pending, deps.sessionState);
        return { id, type, success: true, data };
      }

      const abortController = new AbortController();
      proxyAbortControllers.set(id, abortController);

      try {
        const data = await overlayOwnedSessionState(
          normalizedMethod,
          normalizedPath,
          await performApiProxyFetch(targetUrl, normalizedMethod, requestHeaders, requestBody, abortController.signal, deps),
          deps.sessionState,
        );
        return { id, type, success: true, data };
      } finally {
        proxyAbortControllers.delete(id);
      }
    }

    case 'api:session:message': {
      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const { path: requestPath, headers, bodyText } = (payload || {}) as ApiSessionMessageRequestPayload;
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      if (!/^\/api\/session\/[^/]+\/prompt(?:\?.*)?$/.test(normalizedPath)) {
        const body = JSON.stringify({ error: 'Invalid session message proxy path' });
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };
      const timeoutSignal = AbortSignal.timeout(45000);
      const abortController = new AbortController();
      proxyAbortControllers.set(id, abortController);
      const onTimeout = () => abortController.abort();
      timeoutSignal.addEventListener('abort', onTimeout, { once: true });

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: typeof bodyText === 'string' ? bodyText : '',
          signal: abortController.signal,
        });

        const responseHeaders = collectProxyResponseHeaders(response.headers, deps);
        if (shouldReturnTextBody(response.headers)) {
          const bodyText = await response.text();
          const data: ApiProxyResponsePayload = {
            status: response.status,
            headers: responseHeaders,
            bodyText,
          };

          return { id, type, success: true, data };
        }

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: responseHeaders,
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };

        return { id, type, success: true, data };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          ((error as Error & { name?: string }).name === 'TimeoutError' ||
            (error as Error & { name?: string }).name === 'AbortError');
        const body = JSON.stringify({
          error: isTimeout ? 'OpenCode message forward timed out' : error instanceof Error ? error.message : 'OpenCode message forward failed',
        });
        const data: ApiProxyResponsePayload = {
          status: isTimeout ? 504 : 503,
          headers: { 'content-type': 'application/json' },
          bodyText: body,
        };
        return { id, type, success: true, data };
      } finally {
        timeoutSignal.removeEventListener('abort', onTimeout);
        proxyAbortControllers.delete(id);
      }
    }

    default:
      return null;
  }
}
