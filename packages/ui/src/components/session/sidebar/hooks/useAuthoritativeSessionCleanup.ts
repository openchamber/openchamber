import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cleanupPersistedSessionState } from '@/sync/session-deletion-cleanup';
import {
  buildAuthoritativeSessionIdentityMap,
  findRemovedAuthoritativeSessions,
} from '../authoritativeSessionCleanup';

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

    for (const identity of findRemovedAuthoritativeSessions(previous, current)) {
      cleanupPersistedSessionState({ runtimeKey, ...identity });
    }
    baselineRef.current = { runtimeKey, identities: current };
  }, [enabled, hasAuthoritativeGlobalSessions, sessions]);
};
