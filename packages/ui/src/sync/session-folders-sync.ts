import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { handleSessionFoldersChanged, handleSessionFoldersStreamReady } from '@/stores/useSessionFoldersStore';

const RETURN_READ_THROTTLE_MS = 2_000;

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
    if (event.type !== 'online' && now - lastReturnRead < RETURN_READ_THROTTLE_MS) return;
    lastReturnRead = now;
    handleSessionFoldersStreamReady();
  };
  document.addEventListener('visibilitychange', onReturn);
  const windowSignals = ['focus', 'pageshow', 'online', 'openchamber:system-resume'];
  for (const signal of windowSignals) window.addEventListener(signal, onReturn);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onReturn);
    for (const signal of windowSignals) window.removeEventListener(signal, onReturn);
  };
};
