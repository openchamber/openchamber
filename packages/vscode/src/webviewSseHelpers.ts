const REQUESTED_SSE_STREAM_ID = /^sse_webview_\d+_\d+$/;

export type SseStreamMap = Map<string, AbortController>;

export const buildSseHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  ...(extra || {}),
});

export const allocateSseStreamId = (
  requestedStreamId: string | undefined,
  nextCounter: () => number,
): string => {
  if (typeof requestedStreamId === 'string' && REQUESTED_SSE_STREAM_ID.test(requestedStreamId)) {
    return requestedStreamId;
  }
  return `sse_${nextCounter()}_${Date.now()}`;
};

export const abortAllSseStreams = (streams: SseStreamMap): void => {
  for (const controller of streams.values()) {
    controller.abort();
  }
  streams.clear();
};

export function stopWebviewSseProxy(
  message: { id: string; type: string; payload?: unknown },
  streams: SseStreamMap,
): { id: string; type: string; success: true; data: { stopped: true } } {
  const { id, type, payload } = message;
  const { streamId } = (payload || {}) as { streamId?: string };
  if (typeof streamId === 'string' && streamId.length > 0) {
    const controller = streams.get(streamId);
    if (controller) {
      controller.abort();
      streams.delete(streamId);
    }
  }
  return { id, type, success: true, data: { stopped: true } };
}
