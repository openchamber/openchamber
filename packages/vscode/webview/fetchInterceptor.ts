import { proxyApiRequest, proxySessionMessageRequest, sendBridgeMessage, startSseProxy, stopSseProxy } from './api/bridge';
import { vscodeStreamPerfCount, vscodeStreamPerfMeasure, vscodeStreamPerfObserve } from './api/streamPerf';
import { extractBodyBase64, extractBodyText } from './requestBodyTransport';
import { handleLocalApiRequest } from './localApiRequest';
import {
  buildProxiedResponse,
  headersToRecord,
  isApiPath,
  isLocalRuntimePath,
  isSessionMessageApiPath,
  isSseApiPath,
  normalizeUrl,
} from './httpHelpers';

export type InstallFetchInterceptorOptions = {
  onLocalResponse?: () => void;
};

export const installFetchInterceptor = (options: InstallFetchInterceptorOptions = {}): void => {
  const originalFetch = window.fetch.bind(window);
  let sseStreamCounter = 0;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const targetUrl = typeof input === 'string' || input instanceof URL ? normalizeUrl(input) : normalizeUrl((input as Request).url);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const pathname = targetUrl?.pathname || '';
    const normalizedPathname = pathname.replace(/\/{2,}/g, '/');
    if (targetUrl && normalizedPathname === '/health') {
      const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
      const isReady = connectionStatus === 'connected';
      const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
      return new Response(JSON.stringify({
        status: isReady ? 'ok' : 'connecting',
        isOpenCodeReady: isReady,
        cliAvailable,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetUrl && isLocalRuntimePath(normalizedPathname)) {
      const localResponse = await handleLocalApiRequest(input, targetUrl, init, method);
      if (localResponse) {
        options.onLocalResponse?.();
        return localResponse;
      }

      if (!isApiPath(normalizedPathname)) {
        return originalFetch(input as RequestInfo, init);
      }

      const suffixPath = `${targetUrl.pathname.replace(/^\/api/, '')}${targetUrl.search}`;

      const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
      const headersFromInit = headersToRecord(init?.headers);
      const headers = { ...headersFromRequest, ...headersFromInit };

      if (isSseApiPath(targetUrl.pathname)) {
        // Install the listener before the extension opens the upstream stream. A
        // reconnect can replay an event immediately, before the start response
        // has crossed the VS Code bridge.
        const streamId = `sse_webview_${Date.now()}_${++sseStreamCounter}`;
        const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const onMessage = (event: MessageEvent) => {
              const msg = event.data as { type?: string; streamId?: string; chunk?: string; error?: string };
              if (!msg || msg.streamId !== streamId) return;

              if (msg.type === 'api:sse:chunk' && typeof msg.chunk === 'string') {
                vscodeStreamPerfCount('vscode.webview.sse_chunk');
                vscodeStreamPerfObserve('vscode.webview.sse_chunk_bytes', msg.chunk.length);
                controller.enqueue(encoder.encode(msg.chunk));
                return;
              }

              if (msg.type === 'api:sse:end') {
                vscodeStreamPerfCount('vscode.webview.sse_end');
                unsubscribe?.();
                unsubscribe = null;
                if (typeof msg.error === 'string' && msg.error.length > 0) {
                  controller.error(new Error(msg.error));
                } else {
                  controller.close();
                }
                void stopSseProxy({ streamId }).catch(() => {});
              }
            };

            window.addEventListener('message', onMessage);
            unsubscribe = () => window.removeEventListener('message', onMessage);

            if (signal) {
              const onAbort = () => {
                unsubscribe?.();
                unsubscribe = null;
                try {
                  controller.error(new DOMException('Aborted', 'AbortError'));
                } catch {
                  controller.close();
                }
                void stopSseProxy({ streamId }).catch(() => {});
              };
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener('abort', onAbort, { once: true });
            }
          },
          cancel() {
            unsubscribe?.();
            unsubscribe = null;
            void stopSseProxy({ streamId }).catch(() => {});
          },
        });

        let start;
        try {
          start = await vscodeStreamPerfMeasure('vscode.webview.sse_start_ms', () => startSseProxy({ path: suffixPath, headers, streamId }));
        } catch (error) {
          await stream.cancel();
          throw error;
        }
        if (!start.streamId) {
          void stream.cancel();
          return new Response(null, { status: start.status || 503, headers: start.headers || {} });
        }

        return new Response(stream, { status: start.status || 200, headers: start.headers || { 'content-type': 'text/event-stream' } });
      }

      if (method === 'POST' && isSessionMessageApiPath(targetUrl.pathname)) {
        const bodyText = await extractBodyText(input, init, method);
        const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
        const proxied = await proxySessionMessageRequest({ path: suffixPath, headers, bodyText, signal });
        const response = buildProxiedResponse(proxied);
        options.onLocalResponse?.();
        return response;
      }

      const bodyBase64 = await extractBodyBase64(input, init, method);
      const signal = (input instanceof Request ? input.signal : init?.signal) as AbortSignal | undefined;
      const proxied = await proxyApiRequest({ method, path: suffixPath, headers, bodyBase64, signal });
      const response = buildProxiedResponse(proxied);
      options.onLocalResponse?.();
      return response;
    }

    if (targetUrl && targetUrl.hostname.includes('models.dev')) {
      try {
        const data = await sendBridgeMessage('api:models/metadata');
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        console.warn('[OpenChamber] models.dev request failed via bridge, returning empty metadata:', error);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return originalFetch(input as RequestInfo, init);
  };
};
