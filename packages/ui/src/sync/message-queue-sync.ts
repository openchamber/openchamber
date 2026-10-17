import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { applyMessageQueueUpdatedEvent, useMessageQueueStore } from '@/stores/messageQueueStore';

/**
 * Queue events use the control SSE stream even while OpenCode uses WS. A space's queue lives in
 * that space's own server: it is read once the space is known, again when the host follows its
 * queue again, and with the host's after a gap in the stream.
 */
export const subscribeMessageQueueSync = (runtimeKey: string): (() => void) => {
  const read = new Set<string>();
  const refreshSpace = (spaceId: string) => {
    read.add(spaceId);
    void useMessageQueueStore.getState().refreshSpaceQueue(spaceId);
  };
  const readNewSpaces = (spaceIds: Iterable<string>) => {
    if (runtimeKey !== getRuntimeKey()) return;
    for (const spaceId of spaceIds) if (!read.has(spaceId)) refreshSpace(spaceId);
  };

  readNewSpaces(useSpacesStore.getState().spaces.keys());
  const unsubscribeSpaces = useSpacesStore.subscribe((state, previous) => {
    if (state.spaces !== previous.spaces) readNewSpaces(state.spaces.keys());
  });
  const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') {
      void useMessageQueueStore.getState().resync().catch(() => undefined);
      for (const spaceId of useSpacesStore.getState().spaces.keys()) refreshSpace(spaceId);
    } else if (event.type === 'space-queue-stream') {
      refreshSpace(event.spaceId);
    } else if (event.type === 'openchamber:message-queue.updated') {
      applyMessageQueueUpdatedEvent(event, runtimeKey);
    }
  });
  return () => {
    unsubscribeSpaces();
    unsubscribeEvents();
  };
};
