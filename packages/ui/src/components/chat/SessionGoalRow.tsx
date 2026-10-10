import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useSessionStatus } from '@/sync/sync-context';
import { useGoalObjectiveContent, useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface SessionGoalRowProps {
  sessionId: string | null;
  directory?: string;
}

// The goal as a top row of the composer: informational only (status icon,
// objective or the latest audit note, token usage) plus an inline
// pause/resume action. The manage dialog opens from the composer target
// button, not from here.
export const SessionGoalRow: React.FC<SessionGoalRowProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const objectiveContent = useGoalObjectiveContent(sessionId ?? '', goal);
  const sessionStatus = useSessionStatus(sessionId ?? '', directory);
  const [busy, setBusy] = React.useState(false);

  const handleToggleStatus = React.useCallback(async (nextStatus: 'active' | 'paused') => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await setSessionGoalStatus(sessionId, directory, nextStatus);
    } catch (error) {
      console.warn('[session-goal] status change failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusy(false);
    }
  }, [sessionId, directory, busy, t]);

  if (!sessionId || !enabled || !goal) {
    return null;
  }

  // Accounting only lands on idle ticks — hide the counter until there is a
  // real number (or a budget worth tracking against) instead of showing "0".
  const usage = goal.tokenBudget
    ? t('chat.goal.usage.tokensWithBudget', {
        used: formatGoalTokens(goal.tokensUsed),
        budget: formatGoalTokens(goal.tokenBudget),
      })
    : (goal.tokensUsed > 0 ? t('chat.goal.usage.tokens', { used: formatGoalTokens(goal.tokensUsed) }) : null);

  const pauseResume = goal.status === 'active'
    ? { icon: 'pause' as const, labelKey: 'chat.goal.action.pause' as const, next: 'paused' as const }
    : (goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited'
      ? { icon: 'play' as const, labelKey: 'chat.goal.action.resume' as const, next: 'active' as const }
      : null);

  return (
    <div
      role="group"
      className="flex h-10 min-w-0 items-center gap-2 border-b border-border/60 pl-3 pr-1.5"
      aria-label={t('chat.goal.row.aria')}
      title={objectiveContent ?? undefined}
    >
      <Icon name="target" className="size-3.5 flex-shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {objectiveContent || t('chat.goal.dialog.titleManage')}
      </span>
      {goal.status === 'active' && (!sessionStatus || sessionStatus.type === 'idle') ? (
        // The agent stopped but the goal is still active: the server is
        // sitting out the quiet window and running the audit — show that
        // instead of a static "Active" that looks stuck.
        <span className="flex flex-shrink-0 items-center gap-1 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('chat.goal.status.evaluating')}
        </span>
      ) : (
        <span className="flex-shrink-0 typography-meta text-muted-foreground">
          {t(sessionGoalStatusLabelKey[goal.status] as never)}
        </span>
      )}
      {usage ? (
        <span className="flex-shrink-0 typography-meta tabular-nums text-muted-foreground/70">
          {usage}
        </span>
      ) : null}
      {pauseResume ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleToggleStatus(pauseResume.next)}
          onMouseDown={(event) => event.preventDefault()}
          disabled={busy}
          className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <Icon name={pauseResume.icon} className="size-3" aria-hidden="true" />
          {t(pauseResume.labelKey)}
        </Button>
      ) : null}
    </div>
  );
});

SessionGoalRow.displayName = 'SessionGoalRow';
