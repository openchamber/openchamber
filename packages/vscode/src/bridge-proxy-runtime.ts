import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';
import {
  CREDENTIAL_LIST_ERROR,
  ENTERPRISE_MODE_ERROR,
  isCredentialListRequest,
  isEnterpriseMode,
  isProviderConnectRequest,
} from '../../web/server/lib/enterprise-mode.js';
import { vcsInitRefusal, vcsInitRefusalBody } from '../../web/server/lib/git/repository-root.js';
import { z } from 'zod';
import {
  OPENCODE_TRUST_ROUTE,
  type OpenCodeTrust,
  type OpenCodeTrustAnswer,
  type OpenCodeTrustRouteRequest,
} from '../../web/server/lib/opencode-trust/index.js';
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

const isSseProxyPath = (requestPath: string): boolean => {
  try {
    return new URL(requestPath, 'https://openchamber.invalid').pathname === '/api/event';
  } catch {
    return requestPath === '/api/event';
  }
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  waitForWorktreeRemoval: (directory: string) => Promise<void>;
  sessionState?: Pick<SessionStateStore, 'readArchived' | 'readMetadata' | 'readUnreadBaseline'>;
  openCodeTrust?: OpenCodeTrust;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
};

const proxyAbortControllers = new Map<string, AbortController>();

const COALESCE_READ_PATH = /^\/api\/(config|location|agent|project|command|model|provider)(\b|\/|\?|$)/;
const READ_COALESCE = new Map<string, Promise<ApiProxyResponsePayload>>();

const buildReadCoalesceKey = (targetUrl: string, headers: Record<string, string>): string => {
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => `${name.toLowerCase()}=${value}`)
    .sort()
    .join('\n');
  return `GET ${targetUrl}\n${canonicalHeaders}`;
};

const UNDELIVERED_FETCH_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

const isUndeliveredFetchFailure = (error: unknown): boolean => {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && UNDELIVERED_FETCH_ERROR_CODES.has(code);
};

const normalizeHeaderKeys = (headers: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));

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
  const [archived, stored, unreadSince] = await Promise.all([
    sessionState.readArchived(),
    sessionState.readMetadata(),
    sessionState.readUnreadBaseline(),
  ]);
  if (!archived && !stored && unreadSince === null) return data;
  return { ...data, bodyText: JSON.stringify(overlaySessionResponseBody(body, archived, stored, unreadSince)) };
};

const RESOLVE_PROBE_BASE = 'http://opencode.invalid/';

const WORKTREE_REMOVAL_HOLD_MS = 60_000;
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

const directoriesAsOpenCodeReadsThem = (resolvedPath: string, headers: Record<string, string>): string[] => {
  const url = new URL(resolvedPath, RESOLVE_PROBE_BASE);
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = headers['x-opencode-directory'];
  if (header) {
    let directory = header;
    if (headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(header)) {
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

const holdForWorktreeRemoval = async (
  directories: string[],
  waitForWorktreeRemoval: ProxyRuntimeDeps['waitForWorktreeRemoval'],
): Promise<void> => {
  if (directories.length === 0) return;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(directories.map((directory) => waitForWorktreeRemoval(directory))),
      new Promise<void>((resolve) => { holdTimer = setTimeout(resolve, WORKTREE_REMOVAL_HOLD_MS); }),
    ]);
  } finally {
    clearTimeout(holdTimer);
  }
};

const trustAnswerResponse = (answer: OpenCodeTrustAnswer): ApiProxyResponsePayload => ({
  status: answer.status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  bodyText: JSON.stringify(answer.body),
});

const trustRouteBodySchema = z.object({ directory: z.string().optional(), fingerprint: z.string().nullable().optional() });

const parseTrustRouteBody = (bodyBase64: string | undefined): OpenCodeTrustRouteRequest['body'] => {
  if (!bodyBase64) return undefined;
  try {
    const parsed = trustRouteBodySchema.safeParse(JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const sessionRecordSchema = z.object({ location: z.object({ directory: z.string() }) });
const sessionResponseSchema = z.union([
  z.object({ data: sessionRecordSchema }).transform((payload) => payload.data.location.directory),
  sessionRecordSchema.transform((record) => record.location.directory),
]);

const createSessionDirectoryResolver = (ctx: BridgeContext | undefined) => (
  async (sessionID: string): Promise<string | null> => {
    const apiUrl = await waitForApiUrl(ctx?.manager);
    if (!apiUrl) throw new Error('OpenCode is not available');
    const response = await fetch(new URL(`api/session/${encodeURIComponent(sessionID)}`, `${apiUrl.replace(/\/+$/, '')}/`), {
      headers: { Accept: 'application/json', ...ctx?.manager?.getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Session lookup answered ${response.status}`);
    return sessionResponseSchema.parse(await response.json());
  }
);

const resolveOpenCodePath = (normalizedPath: string): string | null => {
  let resolved: URL;
  try {
    resolved = new URL(normalizedPath.replace(/^\/+/, ''), RESOLVE_PROBE_BASE);
  } catch {
    return null;
  }
  if (resolved.origin !== new URL(RESOLVE_PROBE_BASE).origin) return null;
  return `${resolved.pathname}${resolved.search}`;
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

      const resolvedPath = resolveOpenCodePath(normalizedPath);
      if (resolvedPath === null) {
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'Not an OpenCode path' }),
        };
        return { id, type, success: true, data };
      }

      if (isProviderConnectRequest(normalizedMethod, resolvedPath) && isEnterpriseMode()) {
        const data: ApiProxyResponsePayload = {
          status: 403,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' }),
        };
        return { id, type, success: true, data };
      }

      if (isCredentialListRequest(normalizedMethod, resolvedPath)) {
        const data: ApiProxyResponsePayload = {
          status: 403,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: CREDENTIAL_LIST_ERROR, code: 'credential_list_refused' }),
        };
        return { id, type, success: true, data };
      }

      const vcsInitRefused = await vcsInitRefusal(normalizedMethod, resolvedPath, normalizeHeaderKeys(headers));
      if (vcsInitRefused) {
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify(vcsInitRefusalBody(vcsInitRefused)),
        };
        return { id, type, success: true, data };
      }

      const requestUrl = new URL(resolvedPath, RESOLVE_PROBE_BASE);
      if (deps.openCodeTrust && requestUrl.pathname === OPENCODE_TRUST_ROUTE) {
        const answer = await deps.openCodeTrust.handleRoute({
          method: normalizedMethod,
          query: Object.fromEntries(requestUrl.searchParams),
          body: parseTrustRouteBody(bodyBase64),
        });
        return { id, type, success: true, data: trustAnswerResponse(answer) };
      }

      const localFsResponse = await deps.tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
      if (localFsResponse) {
        return { id, type, success: true, data: localFsResponse };
      }

      await holdForWorktreeRemoval(
        directoriesAsOpenCodeReadsThem(resolvedPath, normalizeHeaderKeys(headers)),
        deps.waitForWorktreeRemoval,
      );

      const trustRefusal = await deps.openCodeTrust?.refusalFor({
        method: normalizedMethod,
        path: resolvedPath,
        headers: normalizeHeaderKeys(headers),
        resolveSessionDirectory: createSessionDirectoryResolver(ctx),
        readBody: async () => (bodyBase64 ? JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8')) : undefined),
      });
      if (trustRefusal) {
        return { id, type, success: true, data: trustAnswerResponse(trustRefusal) };
      }

      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const target = new URL(normalizedPath.replace(/^\/+/, ''), base);
      if (target.origin !== new URL(base).origin) {
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'Not an OpenCode path' }),
        };
        return { id, type, success: true, data };
      }
      const targetUrl = target.toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      const requestBody =
        typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
          ? Buffer.from(bodyBase64, 'base64')
          : undefined;

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
        const unavailable = deps.buildUnavailableApiResponse();
        const data = { ...unavailable, headers: { ...unavailable.headers, 'x-openchamber-error': 'opencode-unreachable' } };
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

      await holdForWorktreeRemoval(
        directoriesAsOpenCodeReadsThem(normalizedPath, normalizeHeaderKeys(headers)),
        deps.waitForWorktreeRemoval,
      );

      const promptRefusal = await deps.openCodeTrust?.refusalFor({
        method: 'POST',
        path: normalizedPath,
        headers: normalizeHeaderKeys(headers),
        resolveSessionDirectory: createSessionDirectoryResolver(ctx),
      });
      if (promptRefusal) {
        return { id, type, success: true, data: trustAnswerResponse(promptRefusal) };
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
          headers: !isTimeout && isUndeliveredFetchFailure(error)
            ? { 'content-type': 'application/json', 'x-openchamber-error': 'opencode-unreachable' }
            : { 'content-type': 'application/json' },
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
