import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cleanupPersistedSessionState } from '@/sync/session-deletion-cleanup';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import {
  buildAuthoritativeSessionIdentityMap,
  findRemovedAuthoritativeSessions,
} from './authoritativeSessionCleanup';

export const useAuthoritativeSessionCleanup = (args: {
  enabled?: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  sessions: Session[];
}): void => {
  const { enabled = true, hasAuthoritativeGlobalSessions, sessions } = args;
  const baselineRef = React.useRef<{
    runtimeKey: string;
    identities: ReturnType<typeof buildAuthoritativeSessionIdentityMap>;
  } | null>(null);

  React.useEffect(() => {
    if (!enabled || !hasAuthoritativeGlobalSessions) return;

    const runtimeKey = getRuntimeKey();
    const current = buildAuthoritativeSessionIdentityMap(sessions);
    const previous = baselineRef.current?.runtimeKey === runtimeKey
      ? baselineRef.current.identities
      : null;

    // A session of an isolated space is missing from the snapshot when the space did not
    // answer or answered in part; only a space's complete answer proves a deletion. A
    // session of a space that is gone altogether is gone with it.
    const spaces = useSpacesStore.getState().spaces;
    for (const identity of findRemovedAuthoritativeSessions(previous, current)) {
      const spaceId = spaceIdOfDirectory(identity.directory);
      const space = spaceId === null ? null : spaces.get(spaceId);
      if (space && space.state !== 'complete') continue;
      cleanupPersistedSessionState({ runtimeKey, ...identity });
    }
    baselineRef.current = { runtimeKey, identities: current };
  }, [enabled, hasAuthoritativeGlobalSessions, sessions]);
};
