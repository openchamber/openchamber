import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import type { JsonObject, JsonValue, TimeoutMs } from '../event-stream/contracts.js';
import type { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { UpstreamFetch } from '../event-stream/upstream-reader.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';

export interface OpenCodeWatcherDependencies {
  waitForOpenCodePort: () => Promise<number | null | void>;
  buildOpenCodeUrl: (route: string, prefix: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  onPayload: (payload: TranslatedEvent, options: { spaceId: string | null }) => void;
  onConnect?: (() => void | Promise<void>) | null;
  onDisconnect?: (() => void) | null;
  onWirePayload?: ((payload: JsonValue, options: { spaceId: string | null }) => void) | null;
  fetchImpl?: UpstreamFetch;
  upstreamStallTimeoutMs?: TimeoutMs;
  upstreamReconnectDelayMs?: TimeoutMs;
  globalEventHub?: Pick<ReturnType<typeof createGlobalMessageStreamHub>, 'subscribeEvent' | 'subscribeStatus' | 'start' | 'isConnected'> | null;
}
const isEventObject = (value: JsonValue | undefined): value is JsonObject => Boolean(value && typeof value === 'object');
const hasErrorFields = (value: unknown): value is { error?: unknown; message?: unknown } => value != null;
const errorFields = <Value>(value: Value) => hasErrorFields(value) ? value : undefined;

export const createOpenCodeWatcherRuntime = (deps: OpenCodeWatcherDependencies) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    onConnect = null,
    onDisconnect = null,
    onWirePayload = null,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
  } = deps;

  let abortController: AbortController | null = null;
  let reader: ReturnType<typeof createUpstreamSseReader> | null = null;
  let unsubscribeEvent: (() => void) | null = null;
  let unsubscribeStatus: (() => void) | null = null;

  const emitTranslated = (payload: JsonValue, spaceId: string | null = null) => {
    onWirePayload?.(payload, { spaceId });
    for (const translated of translateWireEvent(payload)) onPayload(translated, { spaceId });
  };

  const notifyConnected = () => {
    if (!onConnect) return;
    void Promise.resolve().then(onConnect).catch((error) => {
      console.warn('[PushWatcher] reading running sessions failed:', errorFields(error)?.message ?? error);
    });
  };

  const unwrapGlobalEventPayload = (eventData: JsonValue) => {
    if (!isEventObject(eventData)) {
      return null;
    }

    if (isEventObject(eventData.payload)) {
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

    if (globalEventHub) {
      unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload) {
          return;
        }
        emitTranslated(payload, event.spaceId ?? null);
      }, { spaces: true });
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          console.log('[PushWatcher] connected');
          notifyConnected();
          return;
        }
        if (status.type === 'error' || status.type === 'initial-error') {
          console.warn('[PushWatcher] disconnected', errorFields(errorFields(status.error)?.error)?.message ?? errorFields(status.error)?.message ?? status.error);
        }
        if (status.type === 'disconnect' || status.type === 'error' || status.type === 'initial-error') onDisconnect?.();
      });
      globalEventHub.start();
      if (globalEventHub.isConnected()) notifyConnected();
      return;
    }

    reader = createUpstreamSseReader({
      signal,
      buildUrl: () => buildOpenCodeUrl('/api/event', ''),
      getHeaders: getOpenCodeAuthHeaders,
      fetchImpl,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      onConnect() {
        console.log('[PushWatcher] connected');
        notifyConnected();
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload) {
          return;
        }
        emitTranslated(payload);
      },
      onDisconnect() {
        onDisconnect?.();
      },
      onError(error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', errorFields(errorFields(error)?.error)?.message ?? errorFields(error)?.message ?? error);
        onDisconnect?.();
      },
    });

    void reader.start();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
      reader?.stop();
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    } catch {
      reader = null;
    }
    reader = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
