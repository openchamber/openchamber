import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { archiveRun, renameRun } from '@/lib/multirun/runActions';
import type { MultiRunSummary } from '@/lib/multirun/runs';
import type { Session } from '@/lib/opencode/model';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { setSessionWorkState } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionNode } from '../types';
import { normalizePath } from '../utils';

/** The lanes and the sessions they started, past subagents: what Done finishes. */
const collectRunWorkSessions = (laneNodes: readonly SessionNode[]): Session[] => {
  const sessions: Session[] = [];
  const stack = [...laneNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    sessions.push(node.session);
    for (const child of node.children) if (!child.session.parentID) stack.push(child);
  }
  return sessions;
};

/**
 * What a multi-run's row knows and does, whatever draws it: the desktop row
 * with hover actions and menus, the phone's with swipe actions. A click opens
 * the run's newest fusion when it has one, otherwise the overview.
 */
export function useRunWork(run: MultiRunSummary, laneNodes: readonly SessionNode[], onNavigate: () => void) {
  const { t } = useI18n();
  // Selected while the screen shows the run: its overview, or one of its
  // sessions (a click opens the fusion), as a worktree's row is.
  const overviewKey = useUIStore((state) => state.runOverviewKey);
  const showsMember = useSessionUIStore((state) => state.currentSessionId !== null && run.memberIds.includes(state.currentSessionId));
  const isActive = overviewKey === run.key || (overviewKey === null && showsMember);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const workSessions = React.useMemo(() => collectRunWorkSessions(laneNodes), [laneNodes]);
  const inWorkSessions = React.useMemo(() => workSessions.filter(isSessionInWork), [workSessions]);
  const inWork = sessionWorkEnabled && inWorkSessions.length > 0;
  const [busy, setBusy] = React.useState(false);

  const openOverview = (): void => {
    useUIStore.getState().setRunOverviewKey(run.key);
    onNavigate();
  };
  // The run's result, the newest fusion, as a worktree's row opens its
  // session; without one, the overview where the lanes compare.
  const open = (): void => {
    const fusionId = run.fusions[0]?.sessionId;
    if (!fusionId) {
      openOverview();
      return;
    }
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().setCurrentSession(fusionId, useGlobalSessionsStore.getState().entityById.get(fusionId)?.directory ?? null);
    onNavigate();
  };
  const toggleWork = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (inWork) {
        for (const session of inWorkSessions) {
          await setSessionWorkState(session.id, normalizePath(session.directory ?? null), 'done');
        }
        // Done work leaves the working set, as it does for a session.
        leaveFinishedSessions(inWorkSessions.map((session) => session.id));
      } else {
        const first = laneNodes[0]?.session;
        if (first) await setSessionWorkState(first.id, normalizePath(first.directory ?? null), 'open');
      }
    } catch {
      toast.error(inWork ? t('sessions.sidebar.work.done.failed') : t('sessions.sidebar.work.track.failed'));
    } finally {
      setBusy(false);
    }
  };
  const rename = async (next: string): Promise<void> => {
    const title = next.trim();
    if (!title || title === run.title) return;
    const failed = await renameRun(run, title, useGlobalSessionsStore.getState().entityById);
    if (failed.length > 0) toast.error(t('multirun.overview.rename.failed'));
  };
  const archive = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await archiveRun(run);
      if (result.failedIds.length > 0) toast.error(t('multirun.overview.archive.failed'));
      else if (useUIStore.getState().runOverviewKey === run.key) useUIStore.getState().closeMainSurfaces();
    } finally {
      setBusy(false);
    }
  };

  return { isActive, sessionWorkEnabled, inWork, busy, open, openOverview, toggleWork, rename, archive };
}
