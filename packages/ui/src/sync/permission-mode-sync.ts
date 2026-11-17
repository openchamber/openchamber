import { getRuntimeKey } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents, type PermissionPolicySyncEvent } from '@/lib/openchamberEvents';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { usePermissionStore } from '@/stores/permissionStore';

export const subscribePermissionPolicySync = (
  runtimeKey: string,
  apply: (event: PermissionPolicySyncEvent) => void,
): (() => void) => subscribeOpenchamberEvents((event) => {
  if (runtimeKey !== getRuntimeKey()) return;
  const permissions = usePermissionStore.getState();
  if (event.type === 'event-stream-ready') {
    void permissions.hydrate().catch(() => undefined);
    for (const spaceId of useSpacesStore.getState().spaces.keys()) void permissions.refreshSpaceModes(spaceId);
  } else if (event.type === 'space-permission-stream') {
    void permissions.refreshSpaceModes(event.spaceId);
  } else if (event.type === 'permission-policy') {
    apply(event.event);
  }
});

export const subscribeSpacePermissionModes = (runtimeKey: string): (() => void) => {
  const read = new Set<string>();
  const readNewSpaces = (spaceIds: Iterable<string>) => {
    if (runtimeKey !== getRuntimeKey()) return;
    for (const spaceId of spaceIds) {
      if (read.has(spaceId)) continue;
      read.add(spaceId);
      void usePermissionStore.getState().refreshSpaceModes(spaceId).then((done) => { if (!done) read.delete(spaceId); });
    }
  };
  readNewSpaces(useSpacesStore.getState().spaces.keys());
  return useSpacesStore.subscribe((state, previous) => {
    if (state.spaces !== previous.spaces) readNewSpaces(state.spaces.keys());
  });
};
