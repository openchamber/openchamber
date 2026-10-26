import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { handleSessionFoldersChanged, handleSessionFoldersStreamReady } from '@/stores/useSessionFoldersStore';

/**
 * Chat folders are stored by the server and shared by its clients. The server
 * announces each change on the control stream and this client reads the
 * folders again; after a gap in the stream it reads them anyway, since a
 * change may have been missed, and sends what it changed meanwhile.
 */
export const subscribeSessionFoldersSync = (runtimeKey: string): (() => void) => subscribeOpenchamberEvents((event) => {
  if (runtimeKey !== getRuntimeKey()) return;
  if (event.type === 'session-folders-changed') handleSessionFoldersChanged(event.updatedAt);
  else if (event.type === 'event-stream-ready') handleSessionFoldersStreamReady();
});
