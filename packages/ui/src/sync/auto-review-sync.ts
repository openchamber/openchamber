import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { applyAutoReviewUpdatedEvent, isAutoReviewAvailable, useAutoReviewStore } from '@/stores/useAutoReviewStore';

/**
 * Auto-review changes ride the control SSE stream, like the message queue. A space's runs live
 * in that space's own server and come over the same connection the host makes for its queue, so
 * they are read once the space is known, again when the host follows that connection again, and
 * with the host's after a gap in the stream.
 */
export const subscribeAutoReviewSync = (runtimeKey: string): (() => void) => {
  if (!isAutoReviewAvailable()) return () => undefined;
  const read = new Set<string>();
  const refreshSpace = (spaceId: string) => {
    read.add(spaceId);
    void useAutoReviewStore.getState().refreshSpace(spaceId);
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
      void useAutoReviewStore.getState().hydrate().catch(() => undefined);
      for (const spaceId of useSpacesStore.getState().spaces.keys()) refreshSpace(spaceId);
    } else if (event.type === 'space-queue-stream') {
      refreshSpace(event.spaceId);
    } else if (event.type === 'openchamber:auto-review.updated') {
      applyAutoReviewUpdatedEvent(event, runtimeKey);
    }
  });
  return () => {
    unsubscribeSpaces();
    unsubscribeEvents();
  };
};
