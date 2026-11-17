import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';

export const subscribeSessionTodosSync = (runtimeKey: string): (() => void) => {
  const store = useSessionTodosStore.getState();
  store.reset();
  if (isVSCodeRuntime()) return () => undefined;

  const isCurrent = () => runtimeKey === getRuntimeKey();
  return subscribeOpenchamberEvents((event) => {
    if (!isCurrent()) return;
    if (event.type === 'event-stream-ready') {
      for (const [sessionId, entry] of Object.entries(useSessionTodosStore.getState().entries)) {
        void store.load(sessionId, entry.directory, isCurrent).catch((error) => console.warn('[session-todos] failed to read', error));
      }
    } else if (event.type === 'session-todos') {
      store.applyEvent(event.event, isCurrent);
    }
  });
};
