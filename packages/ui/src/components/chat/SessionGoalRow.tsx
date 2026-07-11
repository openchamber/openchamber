import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { SessionGoalDialog } from '@/components/chat/SessionGoalDialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalRowProps {
  sessionId: string | null;
  directory?: string;
  className?: string;
}

// Compact goal strip near the composer: status dot, objective (or the latest
// audit note), and token usage. Tapping it opens the manage dialog.
export const SessionGoalRow: React.FC<SessionGoalRowProps> = React.memo(({ sessionId, directory, className }) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const [dialogOpen, setDialogOpen] = React.useState(false);

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

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1 text-left',
          'border-[var(--interactive-border)] hover:bg-[var(--interactive-hover)]',
          className,
        )}
        aria-label={t('chat.goal.row.aria')}
        title={goal.objective}
      >
        <Icon name="target" className="h-3.5 w-3.5 flex-shrink-0" style={{ color: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate typography-meta text-foreground">
          {goal.note || goal.objective}
        </span>
        <span className="flex-shrink-0 typography-meta text-muted-foreground">
          {t(sessionGoalStatusLabelKey[goal.status] as never)}
        </span>
        {usage ? (
          <span className="flex-shrink-0 typography-meta tabular-nums text-muted-foreground/70">
            {usage}
          </span>
        ) : null}
      </button>
      <SessionGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} sessionId={sessionId} directory={directory} />
    </>
  );
});

SessionGoalRow.displayName = 'SessionGoalRow';
