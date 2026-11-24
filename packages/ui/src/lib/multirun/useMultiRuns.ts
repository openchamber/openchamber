import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { memoizeSessionListProjection } from '@/stores/sessionListProjection';
import { useDeferredGlobalUpdates, withDeferredGlobalUpdate } from '@/sync/session-event-router';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { buildMultiRunIndex, readMultiRunIdentityWith, type MultiRunIndex, type MultiRunSummary } from './runs';

export type MultiRunSessions = {
  index: MultiRunIndex;
  sessionById: ReadonlyMap<string, Session>;
};

const resolveLegacyScope = (session: Session): string | null => normalizePath(
  useSessionUIStore.getState().getWorktreeMetadata(session.id)?.projectDirectory ?? session.directory,
);

export function useMultiRunSessions(): MultiRunSessions {
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const deferredUpdates = useDeferredGlobalUpdates();
  const liveSessions = useAllLiveSessions();
  return React.useMemo(() => {
    const sessionById = new Map<string, Session>();
    for (const session of activeSessions) sessionById.set(session.id, session);
    for (const [sessionId, update] of deferredUpdates) {
      const session = sessionById.get(sessionId);
      if (session) sessionById.set(sessionId, withDeferredGlobalUpdate(session, update));
    }
    for (const session of liveSessions) sessionById.set(session.id, session);
    return { index: buildMultiRunIndex(sessionById.values(), resolveLegacyScope), sessionById };
  }, [activeSessions, deferredUpdates, liveSessions]);
}

const isActiveRoot = (session: Session): boolean => !session.time?.archived && !session.parentID;

export function useMultiRunTitle(runKey: string | null): string | null {
  const selectTitle = React.useMemo(() => {
    const title = memoizeSessionListProjection((
      sessions: Session[],
      key: string,
      _worktrees: ReturnType<typeof useSessionUIStore.getState>['worktreeMetadata'],
    ) => {
      let found: string | null = null;
      let members = 0;
      for (const session of sessions) {
        if (!isActiveRoot(session)) continue;
        const identity = readMultiRunIdentityWith(session, resolveLegacyScope);
        if (identity?.key !== key) continue;
        members += 1;
        found = identity.title ?? found ?? identity.groupSlug;
      }
      return members >= 2 ? found : null;
    });
    return (state: ReturnType<typeof useGlobalSessionsStore.getState>): string | null => (
      runKey ? title(state.activeSessions, runKey, useSessionUIStore.getState().worktreeMetadata) : null
    );
  }, [runKey]);
  return useGlobalSessionsStore(selectTitle);
}

export function useMultiRunMemberIds(sessionId: string | null): readonly string[] {
  const selectMembers = React.useMemo(() => {
    const members = memoizeSessionListProjection((
      sessions: Session[],
      key: string,
      _worktrees: ReturnType<typeof useSessionUIStore.getState>['worktreeMetadata'],
    ) => {
      const ids = sessions
        .filter((session) => isActiveRoot(session) && readMultiRunIdentityWith(session, resolveLegacyScope)?.key === key)
        .map((session) => session.id);
      return ids.length >= 2 ? ids.join('\n') : '';
    });
    return (state: ReturnType<typeof useGlobalSessionsStore.getState>): string => {
      if (!sessionId) return '';
      const own = state.entityById.get(sessionId);
      const key = own && isActiveRoot(own) ? readMultiRunIdentityWith(own, resolveLegacyScope)?.key : undefined;
      if (!key) return '';
      return members(state.activeSessions, key, useSessionUIStore.getState().worktreeMetadata);
    };
  }, [sessionId]);
  const joined = useGlobalSessionsStore(selectMembers);
  return React.useMemo(() => (joined ? joined.split('\n') : []), [joined]);
}

export type MultiRunLookup = { run: MultiRunSummary | null; sessionById: ReadonlyMap<string, Session> };

export function useMultiRun(runKey: string | null): MultiRunLookup {
  const { index, sessionById } = useMultiRunSessions();
  return { run: runKey ? index.runs.get(runKey) ?? null : null, sessionById };
}
