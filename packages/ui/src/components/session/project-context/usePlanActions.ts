import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { resolveProjectContextId, type ProjectPlanLink, type ProjectRef } from '@/lib/projectContextApi';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { holdOpenPlan } from './openPlanViews';
import { planDeleteKey, scheduleKnowledgeDelete } from './pendingKnowledgeDeletes';

type PlanAction = {
  id: 'open-session' | 'move' | 'delete';
  label: string;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * A plan's actions beyond its pin, the same in its list row and in the open
 * plan's menu: open the session it was written in, share or make personal,
 * delete with undo.
 */
export const usePlanActions = (
  projectRef: ProjectRef,
  /** After a move: the project, and the plan's id before and after it (they differ when a team-only plan is made personal). */
  onMoved?: (projectId: string, previousId: string, movedId: string) => void,
) => {
  const { t } = useI18n();
  const movePlan = useProjectContextStore((state) => state.movePlan);
  const removePlan = useProjectContextStore((state) => state.deletePlan);
  const [movingPlanId, setMovingPlanId] = React.useState<string | null>(null);

  // The list reloads from the returned context; whoever shows the plan open
  // follows it to its id after the move through `onMoved`.
  const handleMove = React.useCallback(async (plan: ProjectPlanLink) => {
    if (movingPlanId) return;
    setMovingPlanId(plan.id);
    try {
      // An open view of this plan stops taking typing and writes what it has:
      // the move takes the file away from under it and may give the plan a new
      // id. A failed write keeps the plan where it is, with the text on screen.
      const projectId = resolveProjectContextId(projectRef);
      const held = await holdOpenPlan(projectId, plan.id);
      try {
        if (!held.saved) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.movePlanFailed'), { description: t('rightSidebar.contextNotesTodo.toast.movePlanUnsaved') });
          return;
        }
        const movedId = await movePlan(projectRef, plan.id, plan.source === 'shared' ? 'unshare' : 'share');
        if (movedId) {
          onMoved?.(projectId, plan.id, movedId);
        } else {
          const detail = useProjectContextStore.getState().getEntry(projectRef).error;
          toast.error(t('rightSidebar.contextNotesTodo.toast.movePlanFailed'), detail ? { description: detail } : undefined);
        }
      } finally {
        held.release();
      }
    } finally {
      setMovingPlanId(null);
    }
  }, [movePlan, movingPlanId, onMoved, projectRef, t]);

  const handleDelete = React.useCallback((planId: string) => {
    scheduleKnowledgeDelete({
      key: planDeleteKey(projectRef, planId),
      message: t('rightSidebar.contextNotesTodo.deleted.plan'),
      undoLabel: t('rightSidebar.contextNotesTodo.undo'),
      run: () => removePlan(projectRef, planId),
      onFailure: () => toast.error(t('rightSidebar.contextNotesTodo.toast.deletePlanFailed')),
    });
  }, [projectRef, removePlan, t]);

  const actionsFor = React.useCallback((plan: ProjectPlanLink, options?: { onDeleted?: () => void }): PlanAction[] => {
    const shared = plan.source === 'shared';
    const sessionId = plan.session?.sessionId;
    return [
      ...(sessionId ? [{
        id: 'open-session' as const,
        label: t('rightSidebar.contextNotesTodo.plans.session.open'),
        onSelect: () => void openSessionLink(sessionId, null),
      }] : []),
      {
        id: 'move',
        label: shared
          ? t('rightSidebar.contextNotesTodo.plans.menu.makePersonal')
          : t('rightSidebar.contextNotesTodo.plans.menu.share'),
        hint: shared
          ? t('rightSidebar.contextNotesTodo.plans.makePersonal')
          : t('rightSidebar.contextNotesTodo.plans.share'),
        disabled: movingPlanId === plan.id,
        onSelect: () => void handleMove(plan),
      },
      {
        id: 'delete',
        label: t('rightSidebar.contextNotesTodo.plans.deletePlan'),
        destructive: true,
        onSelect: () => {
          options?.onDeleted?.();
          handleDelete(plan.id);
        },
      },
    ];
  }, [handleDelete, handleMove, movingPlanId, t]);

  return { actionsFor, movingPlanId };
};
