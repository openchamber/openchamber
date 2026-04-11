import { createOpencodeClient } from '@opencode-ai/sdk/v2';

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
  } = deps;

  let abortController = null;

  const unwrapGlobalEventPayload = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    if (eventData.payload && typeof eventData.payload === 'object') {
      return eventData.payload;
    }

    return eventData;
  };

  const start = async () => {
    if (abortController) {
      return;
    }

    await waitForOpenCodePort();

    abortController = new AbortController();
    const signal = abortController.signal;

    let attempt = 0;
    const run = async () => {
      while (!signal.aborted) {
        attempt += 1;
        try {
          const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
          const client = createOpencodeClient({
            baseUrl,
            headers: getOpenCodeAuthHeaders(),
          });

          const result = await client.global.event({
            signal,
            sseMaxRetryAttempts: 0,
            onSseEvent: (event) => {
              const payload = unwrapGlobalEventPayload(event.data);
              if (!payload || typeof payload !== 'object') {
                return;
              }
              onPayload(payload);
            },
          });

          console.log('[PushWatcher] connected');

          for await (const _ of result.stream) {
            void _;
            if (signal.aborted) {
              break;
            }
          }
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          console.warn('[PushWatcher] disconnected', error?.message ?? error);
        }

        const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    };

    void run();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
    } catch {
    }
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
