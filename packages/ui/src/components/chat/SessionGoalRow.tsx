import React from 'react';
import { useComposerStatusChip } from '@/components/chat/composer/state/composerStatusChips';
import { Icon } from '@/components/icon/Icon';
import { useSessionStatus } from '@/sync/sync-context';
import { useGoalObjectiveContent, useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useGoalDriverName } from '@/lib/guests/goal-driver';
import { Spinner } from '@/components/ui/spinner';

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
  // An extension plugin running this goal (e.g. Oh-My-OpenAgent) continues it
  // itself: there is no quiet-window audit to show, and the strip names it.
  const driverName = useGoalDriverName(goal?.driver);
  // The agent stopped but the goal is still active: the server is sitting out
  // the quiet window and running the audit.
  const evaluating = Boolean(sessionId && enabled && goal?.status === 'active' && !goal.driver && (!sessionStatus || sessionStatus.type === 'idle'));

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

  useComposerStatusChip('goal', sessionId && enabled && goal
    ? { icon: 'target', label: objectiveContent || t('chat.goal.dialog.titleManage') }
    : null);

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
      className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5"
      aria-label={t('chat.goal.row.aria')}
    >
      <Icon name="target" className="size-3.5 flex-shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
      {objectiveContent ? (
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{objectiveContent}</span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-[min(480px,calc(100vw-24px))] whitespace-normal break-words text-start">
            <span className="line-clamp-12 whitespace-pre-line">{objectiveContent}</span>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{t('chat.goal.dialog.titleManage')}</span>
      )}
      {driverName ? (
        <span
          className="flex-shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[0.7rem] leading-none text-primary"
          title={t('chat.goal.driver.title', { name: driverName })}
        >
          {driverName}
        </span>
      ) : null}
      {evaluating ? (
        // Show the audit instead of a static "Active" that looks stuck.
        <span className="flex flex-shrink-0 items-center gap-1 typography-meta text-muted-foreground">
          <Spinner className="h-3 w-3" aria-hidden="true" />
          {t('chat.goal.status.evaluating')}
        </span>
      ) : (
        <span className="flex-shrink-0 typography-meta text-muted-foreground">
          {t(sessionGoalStatusLabelKey[goal.status] as never)}
        </span>
      )}
      {usage ? (
        <span className="flex-shrink-0 typography-meta tabular-nums text-muted-foreground">
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
