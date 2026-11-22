import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { applyAutoReviewUpdatedEvent, isAutoReviewAvailable, useAutoReviewStore } from '@/stores/useAutoReviewStore';

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
