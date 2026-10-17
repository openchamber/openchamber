import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { usePermissionStore } from '@/stores/permissionStore';

/**
 * An isolated space keeps the permission modes of its own sessions in its own server, which
 * answers their requests. A space's modes are read once the space is known, and again at the next
 * change of the list after a read that failed; the host's stream announces a gap, see
 * `onSpacePermissionStream` in sync-context.
 */
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
