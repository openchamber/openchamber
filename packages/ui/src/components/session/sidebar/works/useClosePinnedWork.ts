import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { keepsPinnedOutOfWork } from '@/lib/pinnedInWork';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { isSessionPinned } from '@/lib/sessionPins';
import { getSessionWork, isSessionInWork } from '@/lib/sessionWorkMetadata';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { setSessionWorkState } from '@/sync/session-actions';
import type { SidebarWorkRef } from './sidebarWorks';

const attempted = new Set<string>();

const NO_SESSIONS: readonly Session[] = [];

export function useClosePinnedWork({ orderedSessions, pinnedSessionIds, sessionRootIndex, workIndex, isPinnedWork }: {
  orderedSessions: readonly Session[];
  pinnedSessionIds: ReadonlySet<string>;
  sessionRootIndex: ReadonlyMap<string, string>;
  workIndex: { bySessionId: ReadonlyMap<string, SidebarWorkRef> };
  isPinnedWork: (ref: SidebarWorkRef) => boolean;
}): void {
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const pinnedInWork = useSessionDisplayStore((state) => state.pinnedInWork);
  const sessions = React.useMemo(() => {
    if (!sessionWorkEnabled || pinnedInWork) return NO_SESSIONS;
    const open = orderedSessions.filter((session) => {
      if (session.parentID || session.time?.archived || !isSessionInWork(session)) return false;
      if (isSessionPinned(pinnedSessionIds, session.directory, session.id)) return true;
      const root = sessionRootIndex.get(session.id);
      const ref = workIndex.bySessionId.get(session.id) ?? (root ? workIndex.bySessionId.get(root) : undefined);
      return ref !== undefined && isPinnedWork(ref);
    });
    return open.length > 0 ? open : NO_SESSIONS;
  }, [isPinnedWork, orderedSessions, pinnedInWork, pinnedSessionIds, sessionRootIndex, sessionWorkEnabled, workIndex]);
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    const keyOf = (session: Session): string => JSON.stringify([runtimeKey, session.id, getSessionWork(session)?.openedAt ?? null]);
    if (sessions.every((session) => attempted.has(keyOf(session)))) return;
    const isCurrentRuntime = captureRuntimeInstance();
    let cancelled = false;
    void keepsPinnedOutOfWork().then((closes) => {
      if (!closes || cancelled || !isCurrentRuntime()) return;
      for (const session of sessions) {
        const key = keyOf(session);
        if (attempted.has(key)) continue;
        attempted.add(key);
        void setSessionWorkState(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'done')
          .catch((error) => console.warn('[session-work] could not close the work of a pinned session', error));
      }
    });
    return () => { cancelled = true; };
  }, [sessions]);
}
