import { getRuntimeKey } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents, type PermissionPolicySyncEvent } from '@/lib/openchamberEvents';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { usePermissionStore } from '@/stores/permissionStore';

/**
 * Permission modes and requests left for the user, from the control stream. A window whose main
 * event stream runs over SSE hears them nowhere else, and without them it hides a request it
 * believes the server answers. Over the WebSocket they arrive twice; applying either is
 * idempotent. Every connection of the stream reads the modes again, the host's and each known
 * space's, since one changed during a gap would hide that session's requests the same way; so
 * does the host's announcement that it follows a space's modes again.
 */
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
