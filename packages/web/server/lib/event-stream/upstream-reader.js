import { parseSseEventEnvelope } from './protocol.js';

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS * 3;
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;

function waitForReconnectDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  return { ...headers };
}

export function createUpstreamSseReader({
  buildUrl,
  getHeaders = () => ({}),
  fetchImpl = fetch,
  parseBlock = parseSseEventEnvelope,
  initialLastEventId = '',
  signal,
  stallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  reconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}) {
  let running = null;
  let stopped = false;
  let activeController = null;
  let lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';

  const stop = () => {
    stopped = true;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
  };

  signal?.addEventListener('abort', stop, { once: true });

  const start = () => {
    if (running) {
      return running;
    }

    stopped = false;
    running = (async () => {
      while (!stopped && !signal?.aborted) {
        const controller = new AbortController();
        activeController = controller;
        const abortActive = () => controller.abort();
        signal?.addEventListener('abort', abortActive, { once: true });

        let abortReason = null;
        let stallTimer = null;
        const clearStallTimer = () => {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
        };
        const resetStallTimer = () => {
          clearStallTimer();
          if (stallTimeoutMs <= 0) {
            return;
          }

          stallTimer = setTimeout(() => {
            abortReason = 'upstream_stalled';
            controller.abort();
          }, stallTimeoutMs);
        };

        try {
          const url = buildUrl();
          const headers = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...normalizeHeaders(getHeaders()),
          };
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId;
          }

          const response = await fetchImpl(url.toString(), {
            headers,
            signal: controller.signal,
          });

          if (!response?.ok || !response.body) {
            onError?.({
              type: 'upstream_unavailable',
              status: response?.status ?? 0,
              response,
            });
            await waitForReconnectDelay(reconnectDelayMs, signal);
            continue;
          }

          onConnect?.({ response, lastEventId });

          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          let buffer = '';

          resetStallTimer();

          while (!stopped && !signal?.aborted) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            resetStallTimer();
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1 && !stopped && !signal?.aborted) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              const envelope = parseBlock(block);
              if (envelope?.payload) {
                if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                  lastEventId = envelope.eventId;
                }
                onEvent?.({
                  block,
                  envelope,
                  payload: envelope.payload,
                  eventId: envelope.eventId,
                  directory: envelope.directory,
                });
              }
              separatorIndex = buffer.indexOf('\n\n');
            }
          }

          if (!stopped && !signal?.aborted && buffer.trim().length > 0) {
            const block = buffer.trim();
            const envelope = parseBlock(block);
            if (envelope?.payload) {
              if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                lastEventId = envelope.eventId;
              }
              onEvent?.({
                block,
                envelope,
                payload: envelope.payload,
                eventId: envelope.eventId,
                directory: envelope.directory,
              });
            }
          }
        } catch (error) {
          if (!stopped && !signal?.aborted && abortReason !== 'upstream_stalled') {
            onError?.({
              type: 'stream_error',
              error,
            });
          }
        } finally {
          clearStallTimer();
          signal?.removeEventListener('abort', abortActive);
          if (activeController === controller) {
            activeController = null;
          }
          onDisconnect?.({ reason: abortReason ?? (stopped || signal?.aborted ? 'stopped' : 'closed') });
        }

        if (!stopped && !signal?.aborted) {
          await waitForReconnectDelay(reconnectDelayMs, signal);
        }
      }
    })().finally(() => {
      running = null;
    });

    return running;
  };

  return {
    start,
    stop,
    getLastEventId() {
      return lastEventId;
    },
  };
}
