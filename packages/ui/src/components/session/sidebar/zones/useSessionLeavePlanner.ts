import React from 'react';
import { registerSessionLeavePlanner } from '@/sync/session-leave-navigation';
import { isSidebarSectionKey, isSidebarAttentionZoneKey, type SidebarLayout } from '@/stores/sidebarLayout';
import type { SessionSidebarRowModel } from '../sessionSidebarRowModel';
import { getOpenedSessionHistory, holdOpenSessionForDone, releaseOpenSession } from './openSessionHold';
import { resolveLeaveTarget } from './openSessionLeave';
import { requestSidebarReveal } from './sidebarReveal';
import { isSessionUnread } from '@/sync/session-unread';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

const ZONE_CONTAINER_PREFIX = 'activity:';

/** Lists of sessions that need the user; Other active only runs or finished. */
export const isAttentionContainer = (containerKey: string): boolean => {
  if (!containerKey.startsWith(ZONE_CONTAINER_PREFIX)) return false;
  const key = containerKey.slice(ZONE_CONTAINER_PREFIX.length);
  return isSidebarSectionKey(key) && isSidebarAttentionZoneKey(key) && key !== 'other-active';
};

type PlannerInputs = {
  layout: SidebarLayout;
  rowModel: SessionSidebarRowModel;
  projectIdOf: (sessionId: string) => string | null;
};

/**
 * Registers what the open session does when it is marked done or archived,
 * read from the layout and the rows as drawn at that moment. VS Code keeps
 * the classic behaviour and registers nothing.
 */
export const useSessionLeavePlanner = (enabled: boolean, inputs: PlannerInputs): void => {
  const latest = React.useRef(inputs);
  React.useLayoutEffect(() => {
    latest.current = inputs;
  });
  React.useEffect(() => {
    if (!enabled) return undefined;
    return registerSessionLeavePlanner((sessionId, kind, leavingIds) => {
      const { layout, rowModel, projectIdOf } = latest.current;
      const policy = layout.afterLeave;
      if (policy === 'hold') {
        if (kind === 'done') holdOpenSessionForDone(sessionId);
        return { next: null };
      }
      if (policy === 'stay' || policy === 'reveal') {
        if (kind !== 'done') return { next: null };
        const restore = releaseOpenSession(sessionId);
        return {
          next: null,
          cancel: restore,
          afterCommit: policy === 'reveal' ? () => requestSidebarReveal(sessionId, projectIdOf(sessionId)) : undefined,
        };
      }
      const target = resolveLeaveTarget({
        policy,
        sessionId,
        leavingIds,
        entries: rowModel.navigationEntries,
        isAttentionContainer,
        isUnread: (id) => isSessionUnread(useGlobalSessionsStore.getState().entityById.get(id)),
        history: getOpenedSessionHistory(),
      });
      return { next: target ? { id: target.sessionId, directory: target.directory } : null };
    });
  }, [enabled]);
};
