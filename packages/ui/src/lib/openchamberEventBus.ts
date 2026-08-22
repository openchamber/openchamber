// Lightweight event bus for OpenChamber-specific events that arrive through
// the global event WebSocket. This replaces per-tab native EventSource
// connections to /api/openchamber/events and /api/notifications/stream,
// which consumed browser HTTP/1.1 connection pool slots indefinitely.
//
// The event pipeline (sync/event-pipeline.ts) calls publishOpenChamberBusEvent
// when it receives an `openchamber:*` or `notification` event via the WS.
// Consumers (openchamberEvents.ts, useWebNotificationStream.ts) subscribe
// instead of opening their own EventSource connections.

export type OpenChamberBusEvent = {
  type: string;
  properties: unknown;
};

const listeners = new Set<(event: OpenChamberBusEvent) => void>();
const activeChangeListeners = new Set<(active: boolean) => void>();

let wsActive = false;

export const setWsEventPipelineActive = (active: boolean): void => {
  if (wsActive === active) return;
  wsActive = active;
  for (const listener of activeChangeListeners) {
    try {
      listener(active);
    } catch {
      // A listener throwing must not break other listeners.
    }
  }
};

export const isWsEventPipelineActive = (): boolean => wsActive;

export const subscribeWsActiveChanged = (
  listener: (active: boolean) => void,
): (() => void) => {
  activeChangeListeners.add(listener);
  return () => {
    activeChangeListeners.delete(listener);
  };
};

export const publishOpenChamberBusEvent = (event: OpenChamberBusEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A listener throwing must not break other listeners.
    }
  }
};

export const subscribeOpenChamberBusEvents = (
  listener: (event: OpenChamberBusEvent) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Resets all bus state to its initial values. Test-only — production code
 * must never call this. The event bus is a module-level singleton shared
 * across all consumers; tests need a clean slate to avoid listener leaks
 * and stale wsActive from prior test files.
 */
export const __resetOpenChamberEventBusForTesting = (): void => {
  listeners.clear();
  activeChangeListeners.clear();
  wsActive = false;
};
