import { parseSseEventEnvelope } from './protocol.js';
import type { SseEnvelope, TimeoutMs, UpstreamEvent } from './contracts.js';

export interface UpstreamResponse {
  ok: boolean;
  status: number;
  body: Response['body'] | import('node:stream/web').ReadableStream<Uint8Array>;
}
interface UpstreamHeaders extends Record<string, string> {
  Accept: string;
  'Cache-Control': string;
  Connection: string;
  'Last-Event-ID'?: string;
}
export type UpstreamFetch = (url: string, options: { headers: Record<string, string>; signal: AbortSignal }) => Promise<UpstreamResponse>;
export type UpstreamError =
  | { type: 'upstream_unavailable'; status: number; response: UpstreamResponse }
  | { type: 'stream_error'; error: unknown };
export interface UpstreamDisconnect {
  reason: 'upstream_stalled' | 'stopped' | 'closed';
}

export interface UpstreamReaderOptions {
  buildUrl: () => string | URL;
  getHeaders?: () => Record<string, string>;
  fetchImpl?: UpstreamFetch | undefined;
  parseBlock?: (block: string) => SseEnvelope | null;
  initialLastEventId?: string;
  signal?: AbortSignal;
  stallTimeoutMs?: TimeoutMs | undefined;
  reconnectDelayMs?: TimeoutMs | undefined;
  reconnectMaxDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  setTimeoutImpl?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  onEvent?: (event: UpstreamEvent) => void;
  onConnect?: (connection: { response: UpstreamResponse; lastEventId: string }) => void;
  onDisconnect?: (status: UpstreamDisconnect) => void;
  onError?: (error: UpstreamError) => void;
}

const isTimeoutProvider = (value: TimeoutMs): value is () => number => typeof value === 'function';

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS * 3;
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;
const DEFAULT_UPSTREAM_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_UPSTREAM_RECONNECT_BACKOFF_MULTIPLIER = 2;
const INITIAL_RECONNECT_DELAY_MS = 0;

function resolveReconnectDelay(consecutiveFailures: number, baseMs: number, maxMs: number, multiplier: number) {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const safeMax = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : DEFAULT_UPSTREAM_RECONNECT_MAX_DELAY_MS;
  const safeMultiplier = Number.isFinite(multiplier) && multiplier > 1 ? multiplier : DEFAULT_UPSTREAM_RECONNECT_BACKOFF_MULTIPLIER;
  if (safeBase <= 0) {
    return INITIAL_RECONNECT_DELAY_MS;
  }
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  const candidate = safeBase * Math.pow(safeMultiplier, exponent);
  return Math.min(candidate, safeMax);
}

function resolveTimeoutMs(value: TimeoutMs, fallback: number) {
  const resolved = isTimeoutProvider(value) ? value() : value;
  return Number.isFinite(resolved) ? resolved : fallback;
}

function waitForReconnectDelay(ms: number, signal: AbortSignal | undefined, setTimeoutImpl: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = globalThis.setTimeout) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
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

function normalizeHeaders(headers: Record<string, string>) {
  return { ...headers };
}

async function cancelResponseBody(response: UpstreamResponse) {
  if (response?.body) {
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
  setTimeoutImpl = globalThis.setTimeout,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}: UpstreamReaderOptions) {
  let running: Promise<void> | null = null;
  let stopped = false;
  let activeController: AbortController | null = null;
  let lastEventId = initialLastEventId;
  let stopListenerAttached = false;
  let consecutiveReconnectFailures = 0;
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

        let abortReason: UpstreamDisconnect['reason'] | null = null;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
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
          const headers: UpstreamHeaders = {
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
                if (envelope.eventId && envelope.eventId.length > 0) {
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
              if (envelope.eventId && envelope.eventId.length > 0) {
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
