import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    onConnectionState = null,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
  } = deps;

  let abortController = null;
  let reader = null;
  let unsubscribeEvent = null;
  let unsubscribeStatus = null;
  // The upstream reader reconnects on its own (after a stall, for one), and each reconnect is a
  // `connect`. Only the first connection and the first after a reported disconnect are logged, so a
  // healthy stream does not fill the log (dezren39/nix#668).
  let connectLogged = false;
  const logConnected = () => {
    if (connectLogged) return;
    connectLogged = true;
    console.log('[PushWatcher] connected');
  };
  // `diagnostics/local-files.js` classifies these lines by their text; keep it unchanged.
  const logDisconnected = (detail) => {
    connectLogged = false;
    console.warn('[PushWatcher] disconnected', detail);
  };

  // `onPayload` consumers speak the server's own event vocabulary, so the v2
  // wire payload is translated here rather than in each consumer. An event of
  // an isolated space keeps the space's id beside it: its session lives in that
  // space's OpenCode, never in the host's.
  const emitTranslated = (payload, spaceId = null) => {
    for (const translated of translateWireEvent(payload)) onPayload(translated, { spaceId });
  };

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
    connectLogged = false;

    if (globalEventHub) {
      // The events of isolated spaces feed this watcher too, so live status, unread marks and
      // notifications work for a space's sessions as for the host's.
      unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        emitTranslated(payload, event.spaceId ?? null);
      }, { spaces: true });
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          onConnectionState?.(true);
          logConnected();
          return;
        }
        if (status.type === 'error' || status.type === 'initial-error') {
          onConnectionState?.(false);
          logDisconnected(status.error?.error?.message ?? status.error?.message ?? status.error);
        }
      });
      globalEventHub.start();
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
        onConnectionState?.(true);
        logConnected();
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        emitTranslated(payload);
      },
      onError(error) {
        if (signal.aborted) {
          return;
        }
        onConnectionState?.(false);
        logDisconnected(error?.error?.message ?? error?.message ?? error);
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
    }
    reader = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
    onConnectionState?.(false);
  };

  return {
    start,
    stop,
  };
};
