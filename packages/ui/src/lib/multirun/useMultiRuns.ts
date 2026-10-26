import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
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

/**
 * Runs across every project, from the global session cache overlaid with the
 * live per-directory records (fresher metadata and timestamps). Surfaces that
 * are not the sidebar (overview, tabs, mobile sheet, auto-fusion) share this.
 */
export function useMultiRunSessions(): MultiRunSessions {
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions();
  return React.useMemo(() => {
    const sessionById = new Map<string, Session>();
    for (const session of activeSessions) sessionById.set(session.id, session);
    for (const session of liveSessions) sessionById.set(session.id, session);
    return { index: buildMultiRunIndex(sessionById.values(), resolveLegacyScope), sessionById };
  }, [activeSessions, liveSessions]);
}

const isActiveRoot = (session: Session): boolean => !session.time?.archived && !session.parentID;

/**
 * Title of a run, read straight from the global session cache. A primitive
 * result keeps always-mounted chrome (the header) from re-rendering on
 * unrelated session updates; with no run key it does no work.
 */
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

/**
 * Ids of every active member of the run `sessionId` belongs to, or an empty
 * list. Joined into one string inside the selector so the caller re-renders
 * only when membership changes.
 */
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
