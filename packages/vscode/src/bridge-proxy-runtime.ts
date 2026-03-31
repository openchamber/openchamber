import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';

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

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
};

export async function handleProxyBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:proxy': {
      const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

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

      if (normalizedPath === '/event' || normalizedPath === '/global/event') {
        if (!requestHeaders.Accept) {
          requestHeaders.Accept = 'text/event-stream';
        }
        requestHeaders['Cache-Control'] = requestHeaders['Cache-Control'] || 'no-cache';
        requestHeaders.Connection = requestHeaders.Connection || 'keep-alive';
      }

      try {
        const response = await fetch(targetUrl, {
          method: normalizedMethod,
          headers: requestHeaders,
          body:
            typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
              ? Buffer.from(bodyBase64, 'base64')
              : undefined,
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };

        return { id, type, success: true, data };
      } catch (error) {
        const body = JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
        });
        const data: ApiProxyResponsePayload = {
          status: 502,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
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

      if (!/^\/session\/[^/]+\/message(?:\?.*)?$/.test(normalizedPath)) {
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

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: typeof bodyText === 'string' ? bodyText : '',
          signal: AbortSignal.timeout(45000),
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
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
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    default:
      return null;
  }
}
