import type { OpenCodeManager } from '../opencode';
import type { BridgeRequest, BridgeResponse } from '../bridge-types';
import { openSseProxy } from '../sseProxy';

export type SsePostMessage = (message: unknown) => void;

const buildSseHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  ...(extra || {}),
});

/**
 * Per-webview (or per-panel) SSE stream bookkeeping shared by all hosts.
 */
export class SseProxySession {
  private counter = 0;
  private readonly streams = new Map<string, AbortController>();

  constructor(
    private readonly getManager: () => OpenCodeManager | undefined,
    private readonly post: SsePostMessage,
  ) {}

  abortAll(): void {
    for (const controller of this.streams.values()) {
      controller.abort();
    }
    this.streams.clear();
  }

  async start(message: BridgeRequest): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { path, headers, streamId: requestedStreamId } = (payload || {}) as {
      path?: string;
      headers?: Record<string, string>;
      streamId?: string;
    };
    const normalizedPath = typeof path === 'string' && path.trim().length > 0 ? path.trim() : '/event';
    const manager = this.getManager();

    if (!manager) {
      return {
        id,
        type,
        success: true,
        data: { status: 503, headers: { 'content-type': 'application/json' }, streamId: null },
      };
    }

    const streamId = typeof requestedStreamId === 'string' && /^sse_webview_\d+_\d+$/.test(requestedStreamId)
      ? requestedStreamId
      : `sse_${++this.counter}_${Date.now()}`;
    const controller = new AbortController();
    this.streams.set(streamId, controller);

    try {
      const start = await openSseProxy({
        manager,
        path: normalizedPath,
        headers: buildSseHeaders(headers),
        signal: controller.signal,
        onChunk: (chunk) => {
          this.post({ type: 'api:sse:chunk', streamId, chunk });
        },
      });

      start.run
        .then(() => {
          this.post({ type: 'api:sse:end', streamId });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            const messageText = error instanceof Error ? error.message : String(error);
            this.post({ type: 'api:sse:end', streamId, error: messageText });
          }
        })
        .finally(() => {
          this.streams.delete(streamId);
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
      this.streams.delete(streamId);
      const messageText = error instanceof Error ? error.message : String(error);
      return {
        id,
        type,
        success: true,
        data: { status: 502, headers: { 'content-type': 'application/json' }, streamId: null, error: messageText },
      };
    }
  }

  async stop(message: BridgeRequest): Promise<BridgeResponse> {
    const { id, type, payload } = message;
    const { streamId } = (payload || {}) as { streamId?: string };
    if (typeof streamId === 'string' && streamId.length > 0) {
      const controller = this.streams.get(streamId);
      if (controller) {
        controller.abort();
        this.streams.delete(streamId);
      }
    }
    return { id, type, success: true, data: { stopped: true } };
  }
}
