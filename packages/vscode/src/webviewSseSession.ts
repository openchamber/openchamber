import type { OpenCodeManager } from './opencode';
import type { BridgeRequest, BridgeResponse } from './bridge';
import { openSseProxy } from './sseProxy';
import {
  allocateSseStreamId,
  buildSseHeaders,
  type SseStreamMap,
} from './webviewSseHelpers';

export {
  abortAllSseStreams,
  stopWebviewSseProxy,
  type SseStreamMap,
} from './webviewSseHelpers';

export type StartWebviewSseProxyOptions = {
  message: BridgeRequest;
  manager: OpenCodeManager | undefined;
  streams: SseStreamMap;
  nextCounter: () => number;
  postMessage: (message: unknown) => void;
};

export async function startWebviewSseProxy(options: StartWebviewSseProxyOptions): Promise<BridgeResponse> {
  const { message, manager, streams, nextCounter, postMessage } = options;
  const { id, type, payload } = message;
  const {
    path,
    headers,
    streamId: requestedStreamId,
  } = (payload || {}) as {
    path?: string;
    headers?: Record<string, string>;
    streamId?: string;
  };
  const normalizedPath = typeof path === 'string' && path.trim().length > 0 ? path.trim() : '/event';

  if (!manager) {
    return {
      id,
      type,
      success: true,
      data: { status: 503, headers: { 'content-type': 'application/json' }, streamId: null },
    };
  }

  const streamId = allocateSseStreamId(requestedStreamId, nextCounter);
  const controller = new AbortController();
  streams.set(streamId, controller);

  try {
    const start = await openSseProxy({
      manager,
      path: normalizedPath,
      headers: buildSseHeaders(headers),
      signal: controller.signal,
      onChunk: (chunk) => {
        postMessage({ type: 'api:sse:chunk', streamId, chunk });
      },
    });

    start.run
      .then(() => {
        postMessage({ type: 'api:sse:end', streamId });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const messageText = error instanceof Error ? error.message : String(error);
          postMessage({ type: 'api:sse:end', streamId, error: messageText });
        }
      })
      .finally(() => {
        streams.delete(streamId);
      });

    return {
      id,
      type,
      success: true,
      data: {
        status: 200,
        headers: start.headers,
        streamId,
      },
    };
  } catch (error) {
    streams.delete(streamId);
    const messageText = error instanceof Error ? error.message : String(error);
    return {
      id,
      type,
      success: true,
      data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: messageText },
    };
  }
}
