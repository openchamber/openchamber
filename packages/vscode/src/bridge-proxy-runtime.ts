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
  readSettings: (ctx: BridgeContext | undefined) => Record<string, unknown>;
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

      if (normalizedMethod === 'GET' && normalizedPath === '/openchamber/backends') {
        const settings = deps.readSettings(ctx);
        const configuredDefaultBackend =
          typeof settings?.defaultBackend === 'string' && settings.defaultBackend.trim().length > 0
            ? settings.defaultBackend.trim()
            : 'opencode';
        const body = JSON.stringify({
          defaultBackend: configuredDefaultBackend,
          backends: [
            {
              id: 'opencode',
              label: 'OpenCode',
              available: true,
              comingSoon: false,
              capabilities: {
                chat: true,
                sessions: true,
                models: true,
                agents: true,
                providers: true,
                commands: true,
                config: true,
                skills: true,
              },
            },
            {
              id: 'codex',
              label: 'Codex',
              available: false,
              comingSoon: true,
              capabilities: {
                chat: false,
                sessions: false,
                models: false,
                agents: false,
                providers: false,
                commands: false,
                config: false,
                skills: false,
              },
            },
            {
              id: 'claude',
              label: 'Claude',
              available: false,
              comingSoon: true,
              capabilities: {
                chat: false,
                sessions: false,
                models: false,
                agents: false,
                providers: false,
                commands: false,
                config: false,
                skills: false,
              },
            },
            {
              id: 'gemini',
              label: 'Gemini',
              available: false,
              comingSoon: true,
              capabilities: {
                chat: false,
                sessions: false,
                models: false,
                agents: false,
                providers: false,
                commands: false,
                config: false,
                skills: false,
              },
            },
            {
              id: 'cursor',
              label: 'Cursor',
              available: false,
              comingSoon: true,
              capabilities: {
                chat: false,
                sessions: false,
                models: false,
                agents: false,
                providers: false,
                commands: false,
                config: false,
                skills: false,
              },
            },
          ],
        });
        const data: ApiProxyResponsePayload = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
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

      let requestBodyBase64 = bodyBase64;
      let requestedBackendId = 'opencode';
      if (normalizedMethod === 'POST' && normalizedPath === '/session' && typeof bodyBase64 === 'string' && bodyBase64.length > 0) {
        try {
          const decoded = Buffer.from(bodyBase64, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded) as Record<string, unknown>;
          requestedBackendId =
            typeof parsed?.backendId === 'string' && parsed.backendId.trim().length > 0
              ? parsed.backendId.trim()
              : 'opencode';
          delete parsed.backendId;
          requestBodyBase64 = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');
        } catch {
          requestBodyBase64 = bodyBase64;
        }
      }

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
            typeof requestBodyBase64 === 'string' && requestBodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
              ? Buffer.from(requestBodyBase64, 'base64')
              : undefined,
        });

        const arrayBuffer = await response.arrayBuffer();
        let responseBodyBase64 = Buffer.from(arrayBuffer).toString('base64');
        if (normalizedMethod === 'POST' && normalizedPath === '/session') {
          try {
            const decoded = Buffer.from(responseBodyBase64, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
              parsed.backendId = requestedBackendId;
              responseBodyBase64 = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');
            }
          } catch {
            // Leave the upstream response body unchanged when it is not JSON.
          }
        }
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: responseBodyBase64,
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
