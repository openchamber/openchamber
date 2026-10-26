import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionWarmingStore } from '@/stores/useSessionWarmingStore';

/**
 * Mirrors the server's per-session warming. The snapshot is read when the
 * control stream (re)connects, since changes during a gap were not seen, and
 * each change arrives whole on the stream. VS Code has no OpenChamber server
 * and keeps only OpenCode's global warming, so its store stays empty.
 */
export const subscribeSessionWarmingSync = (runtimeKey: string): (() => void) => {
  const store = useSessionWarmingStore.getState();
  // Another runtime's sessions and revisions mean nothing here.
  store.reset();
  if (isVSCodeRuntime()) return () => undefined;

  const refresh = () => {
    void store.refresh(() => runtimeKey === getRuntimeKey()).catch((error) => console.warn('[session-warming] failed to read the state', error));
  };
  // The stream may already be connected, and then no ready event comes for this listener.
  refresh();
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') refresh();
    else if (event.type === 'session-warming') store.applySnapshot(event.snapshot);
  });
};
