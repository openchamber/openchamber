import { parseSseEventEnvelope } from './protocol.js';
import { DEFAULT_UPSTREAM_STALL_TIMEOUT_MS } from './timeouts.js';

export { DEFAULT_UPSTREAM_STALL_TIMEOUT_MS };
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;
// Cap on one partial (separator-less) SSE block retained between chunks. A complete block may be
// larger — it is drained as soon as its separator arrives — but a stream that never sends the
// separator must not grow this buffer without bound: the proxy's boundary tracker caps its tail
// at 4096 chars and the WS layer caps per-client buffering at 16 MiB, so a 4 MiB partial-block
// cap sits between those precedents and far above any heartbeat or ordinary event fragment.
export const UPSTREAM_SSE_MAX_BUFFERED_CHARS = 4 * 1024 * 1024;
const DEFAULT_UPSTREAM_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_UPSTREAM_RECONNECT_BACKOFF_MULTIPLIER = 2;
const INITIAL_RECONNECT_DELAY_MS = 0;

function resolveReconnectDelay(consecutiveFailures, baseMs, maxMs, multiplier) {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const safeMax = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : DEFAULT_UPSTREAM_RECONNECT_MAX_DELAY_MS;
  const safeMultiplier = Number.isFinite(multiplier) && multiplier > 1 ? multiplier : DEFAULT_UPSTREAM_RECONNECT_BACKOFF_MULTIPLIER;
  if (safeBase <= 0) {
    return INITIAL_RECONNECT_DELAY_MS;
  }
  // Conventional exponential backoff: first failure waits `base`, then `base * multiplier`,
  // `base * multiplier^2`, etc., capped at `max`. The counter passed in is incremented BEFORE this
  // call (so the first failure uses counter = 1 and waits `base * multiplier^0` = base).
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  const candidate = safeBase * Math.pow(safeMultiplier, exponent);
  return Math.min(candidate, safeMax);
}

function resolveTimeoutMs(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value;
  return Number.isFinite(resolved) ? resolved : fallback;
}

function waitForReconnectDelay(ms, signal, setTimeoutImpl = globalThis.setTimeout) {
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
    const timeout = setTimeoutImpl(finish, Math.max(0, ms));
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
  reconnectMaxDelayMs = DEFAULT_UPSTREAM_RECONNECT_MAX_DELAY_MS,
  reconnectBackoffMultiplier = DEFAULT_UPSTREAM_RECONNECT_BACKOFF_MULTIPLIER,
  maxBufferedChars = UPSTREAM_SSE_MAX_BUFFERED_CHARS,
  setTimeoutImpl = globalThis.setTimeout,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}) {
  let running = null;
  let stopped = false;
  let activeController = null;
  let lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';
  let stopListenerAttached = false;
  let consecutiveReconnectFailures = 0;
  // Buffer overflows need their own counter: a successful HTTP response resets
  // `consecutiveReconnectFailures` before the read starts, so an overflow-only loop would
  // otherwise always reconnect at the base delay. This counter survives reconnects and is
  // reset only when a complete event is delivered (healthy progress).
  let overflowReconnectFailures = 0;
  // A function delay belongs to a caller that keeps its own backoff (space
  // events); a number is the base of this reader's exponential backoff.
  const nextReconnectDelay = () => (reconnectDelayMs instanceof Function
    ? resolveTimeoutMs(reconnectDelayMs, DEFAULT_UPSTREAM_RECONNECT_DELAY_MS)
    : resolveReconnectDelay(consecutiveReconnectFailures, reconnectDelayMs, reconnectMaxDelayMs, reconnectBackoffMultiplier));

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
            consecutiveReconnectFailures += 1;
            onError?.({
              type: 'upstream_unavailable',
              status: response?.status ?? 0,
              response,
            });
            await cancelResponseBody(response);
            await waitForReconnectDelay(nextReconnectDelay(), signal, setTimeoutImpl);
            continue;
          }

          consecutiveReconnectFailures = 0;
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
                overflowReconnectFailures = 0;
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

            if (!stopped && !signal?.aborted && buffer.length > maxBufferedChars) {
              // A separator-less stream would retain this partial block forever (and the stall
              // timer resets on every chunk, so it cannot save us). End the read observably:
              // name the overflow, drop the partial block, and abort so the outer loop
              // reconnects from the last complete event id.
              abortReason = 'upstream_buffer_overflow';
              onError?.({
                type: 'upstream_buffer_overflow',
                bufferedChars: buffer.length,
                maxBufferedChars,
              });
              buffer = '';
              overflowReconnectFailures += 1;
              consecutiveReconnectFailures = overflowReconnectFailures;
              controller.abort();
              break;
            }
          }

          if (!stopped && !signal?.aborted && abortReason !== 'upstream_buffer_overflow' && buffer.trim().length > 0) {
            const block = buffer.trim();
            const envelope = parseBlock(block);
            if (envelope?.payload) {
              overflowReconnectFailures = 0;
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
          if (!stopped && !signal?.aborted && abortReason !== 'upstream_stalled' && abortReason !== 'upstream_buffer_overflow') {
            consecutiveReconnectFailures += 1;
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
          await waitForReconnectDelay(nextReconnectDelay(), signal, setTimeoutImpl);
        }
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
