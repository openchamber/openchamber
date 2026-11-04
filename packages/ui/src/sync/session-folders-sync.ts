import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { handleSessionFoldersChanged, handleSessionFoldersStreamReady } from '@/stores/useSessionFoldersStore';

// One return fires several of these signals at once; this makes them one read.
const RETURN_READ_THROTTLE_MS = 2_000;

/**
 * Chat folders are stored by the server and shared by its clients. The server
 * announces each change on the control stream and this client reads the
 * folders again; after a gap in the stream it reads them anyway, since a
 * change may have been missed, and sends what it changed meanwhile. A window
 * coming back does the same at once: its stream may be dead without it knowing,
 * and the heartbeat timer that would notice is throttled while it is hidden.
 */
export const subscribeSessionFoldersSync = (runtimeKey: string): (() => void) => {
  const unsubscribe = subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'session-folders-changed') handleSessionFoldersChanged(event.updatedAt);
    else if (event.type === 'event-stream-ready') handleSessionFoldersStreamReady();
  });

  let lastReturnRead = Number.NEGATIVE_INFINITY;
  const onReturn = (event: Event) => {
    if (runtimeKey !== getRuntimeKey() || document.visibilityState === 'hidden') return;
    const now = Date.now();
    // A read made just before the network came back failed and waits for this signal.
    if (event.type !== 'online' && now - lastReturnRead < RETURN_READ_THROTTLE_MS) return;
    lastReturnRead = now;
    handleSessionFoldersStreamReady();
  };
  document.addEventListener('visibilitychange', onReturn);
  // openchamber:system-resume comes from Electron on wake and from the phone on foreground.
  const windowSignals = ['focus', 'pageshow', 'online', 'openchamber:system-resume'];
  for (const signal of windowSignals) window.addEventListener(signal, onReturn);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onReturn);
    for (const signal of windowSignals) window.removeEventListener(signal, onReturn);
  };
};
