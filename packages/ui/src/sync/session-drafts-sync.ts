import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';

/**
 * Session drafts are stored by the server and shared by its clients. The
 * server announces each change on the control stream and this client reads
 * them again; after a gap in the stream it reads them anyway, since a change
 * may have been missed. VS Code has no OpenChamber server: its drafts stay in
 * the composer.
 */
export const subscribeSessionDraftsSync = (runtimeKey: string): (() => void) => {
  if (isVSCodeRuntime()) return () => undefined;
  void useSessionDraftsStore.getState().load();
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'session-drafts-changed' || event.type === 'event-stream-ready') void useSessionDraftsStore.getState().load();
  });
};
