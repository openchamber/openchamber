import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';

export const subscribeSessionDraftsSync = (runtimeKey: string): (() => void) => {
  if (isVSCodeRuntime()) return () => undefined;
  void useSessionDraftsStore.getState().load();
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'session-drafts-changed' || event.type === 'event-stream-ready') void useSessionDraftsStore.getState().load();
  });
};
