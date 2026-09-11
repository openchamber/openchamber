import { parseSseEventEnvelope } from './protocol.js';

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS * 3;
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;
// Cap the wait between consecutive failed reconnect attempts so a down
// upstream cannot be retried at the base delay indefinitely.
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MAX_MS = 30_000;
// A throw from `buildUrl` means OpenCode currently has no addressable URL
// (for example the managed process is dead and its port is gone). Parking is
// opt-in: only a caller that passes `onParked` can handle the terminal state,
// so after this many consecutive failures the reader parks until an explicit
// restart only when `onParked` is provided. Without it the reader keeps
// retrying with capped backoff and reports each failure through `onError`.
// Transient upstream/stream errors keep retrying with capped backoff.
export const DEFAULT_UPSTREAM_BUILD_URL_FAILURE_LIMIT = 5;

function resolveTimeoutMs(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value;
  return Number.isFinite(resolved) ? resolved : fallback;
}

function resolveCount(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function waitForReconnectDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  return { ...headers };
}

async function cancelResponseBody(response) {
  if (response?.body && typeof response.body.cancel === 'function') {
    await response.body.cancel().catch(() => {});
  }
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
  reconnectDelayMaxMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MAX_MS,
  buildUrlFailureLimit = DEFAULT_UPSTREAM_BUILD_URL_FAILURE_LIMIT,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
  onParked,
}) {
  let running = null;
  let stopped = false;
  let parked = false;
  let activeController = null;
  let lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';
  let stopListenerAttached = false;
  let reconnectFailures = 0;
  let consecutiveBuildUrlFailures = 0;

  const nextReconnectDelayMs = () => {
    const base = Math.max(0, resolveTimeoutMs(reconnectDelayMs, DEFAULT_UPSTREAM_RECONNECT_DELAY_MS));
    const max = Math.max(base, resolveTimeoutMs(reconnectDelayMaxMs, DEFAULT_UPSTREAM_RECONNECT_DELAY_MAX_MS));
    const delay = Math.min(max, base * 2 ** reconnectFailures);
    reconnectFailures += 1;
    return delay;
  };

  function detachStopListener() {
    if (!stopListenerAttached) return;
    signal?.removeEventListener('abort', stop);
    stopListenerAttached = false;
  }

  function attachStopListener() {
    if (!signal || signal.aborted || stopListenerAttached) return;
    signal.addEventListener('abort', stop, { once: true });
    stopListenerAttached = true;
  }

  function stop() {
    stopped = true;
    detachStopListener();
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
  }

  const start = () => {
    if (running) {
      return running;
    }

    attachStopListener();
    stopped = false;
    parked = false;
    reconnectFailures = 0;
    consecutiveBuildUrlFailures = 0;
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
          const currentStallTimeoutMs = resolveTimeoutMs(stallTimeoutMs, DEFAULT_UPSTREAM_STALL_TIMEOUT_MS);
          if (currentStallTimeoutMs <= 0) {
            return;
          }

          stallTimer = setTimeout(() => {
            abortReason = 'upstream_stalled';
            controller.abort();
          }, currentStallTimeoutMs);
        };

        let buildUrlFailed = false;
        try {
          let url;
          try {
            url = buildUrl();
            consecutiveBuildUrlFailures = 0;
          } catch (error) {
            buildUrlFailed = true;
            consecutiveBuildUrlFailures += 1;
            throw error;
          }

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
            await cancelResponseBody(response);
            await waitForReconnectDelay(nextReconnectDelayMs(), signal);
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

            // Bytes from the upstream prove it is actually serving, so the
            // next failed attempt starts over from the base delay.
            reconnectFailures = 0;
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
          if (buildUrlFailed) {
            const limit = resolveCount(buildUrlFailureLimit, DEFAULT_UPSTREAM_BUILD_URL_FAILURE_LIMIT);
            // Parking is opt-in on the caller providing `onParked`. Without a
            // handler the reader must not enter a terminal state, otherwise an
            // isolated caller (for example the watcher fallback) silently
            // loses recovery; report through `onError` and keep retrying.
            if (onParked && consecutiveBuildUrlFailures >= limit) {
              parked = true;
              onParked({
                type: 'build_url_failed',
                error,
              });
            } else {
              onError?.({
                type: 'build_url_failed',
                error,
              });
            }
          } else if (!stopped && !signal?.aborted && abortReason !== 'upstream_stalled') {
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

        if (parked || stopped || signal?.aborted) {
          break;
        }

        await waitForReconnectDelay(nextReconnectDelayMs(), signal);
      }
    })().finally(() => {
      detachStopListener();
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
