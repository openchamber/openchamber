import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useSessionStatus } from '@/sync/sync-context';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalRowProps {
  sessionId: string | null;
  directory?: string;
  className?: string;
}

// Compact goal strip near the composer: informational only — status dot,
// objective (or the latest audit note), token usage — plus an inline
// pause/resume action. The manage dialog opens from the composer target
// button, not from here.
export const SessionGoalRow: React.FC<SessionGoalRowProps> = React.memo(({ sessionId, directory, className }) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
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
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1',
        'border-[var(--interactive-border)]',
        className,
      )}
      aria-label={t('chat.goal.row.aria')}
      title={goal.objective}
    >
      <Icon name="target" className="h-3.5 w-3.5 flex-shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate typography-meta text-foreground">
        {goal.note || goal.objective}
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
        <button
          type="button"
          onClick={() => void handleToggleStatus(pauseResume.next)}
          disabled={busy}
          className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 typography-meta text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground disabled:opacity-50"
          aria-label={t(pauseResume.labelKey)}
        >
          <Icon name={pauseResume.icon} className="h-3 w-3" aria-hidden="true" />
          <span>{t(pauseResume.labelKey)}</span>
        </button>
      ) : null}
    </div>
  );
});

SessionGoalRow.displayName = 'SessionGoalRow';
