import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDeferredGlobalUpdates, withDeferredGlobalUpdate } from '@/sync/session-event-router';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { buildMultiRunIndex, readMultiRunIdentity, type MultiRunIndex, type MultiRunSummary } from './runs';

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
  return useGlobalSessionsStore(React.useCallback((state) => {
    if (!runKey) return null;
    let title: string | null = null;
    let members = 0;
    for (const session of state.activeSessions) {
      if (!isActiveRoot(session)) continue;
      const identity = readMultiRunIdentity(session, resolveLegacyScope(session));
      if (identity?.key !== runKey) continue;
      members += 1;
      title = identity.title ?? title ?? identity.groupSlug;
    }
    return members >= 2 ? title : null;
  }, [runKey]));
}

export function useMultiRunMemberIds(sessionId: string | null): readonly string[] {
  const joined = useGlobalSessionsStore(React.useCallback((state) => {
    if (!sessionId) return '';
    const own = state.activeSessions.find((session) => session.id === sessionId);
    const key = own && isActiveRoot(own) ? readMultiRunIdentity(own, resolveLegacyScope(own))?.key : undefined;
    if (!key) return '';
    const ids = state.activeSessions
      .filter((session) => isActiveRoot(session) && readMultiRunIdentity(session, resolveLegacyScope(session))?.key === key)
      .map((session) => session.id);
    return ids.length >= 2 ? ids.join('\n') : '';
  }, [sessionId]));
  return React.useMemo(() => (joined ? joined.split('\n') : []), [joined]);
}

export type MultiRunLookup = { run: MultiRunSummary | null; sessionById: ReadonlyMap<string, Session> };

export function useMultiRun(runKey: string | null): MultiRunLookup {
  const { index, sessionById } = useMultiRunSessions();
  return { run: runKey ? index.runs.get(runKey) ?? null : null, sessionById };
}
