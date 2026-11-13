import type { I18nKey } from '@/lib/i18n';
import type { SessionGoalStatus } from '@/lib/sessionGoalMetadata';

// Shared presentation mapping for the goal status across chat, sidebar and
// mobile surfaces. Colors are theme tokens; labels resolve through i18n at
// the call site.
export const sessionGoalStatusColor: Record<SessionGoalStatus, string> = {
  active: 'var(--status-info)',
  paused: 'var(--surface-muted-foreground)',
  blocked: 'var(--status-warning)',
  budgetLimited: 'var(--status-warning)',
  complete: 'var(--status-success)',
};

export const sessionGoalStatusLabelKey: Record<SessionGoalStatus, string> = {
  active: 'chat.goal.status.active',
  paused: 'chat.goal.status.paused',
  blocked: 'chat.goal.status.blocked',
  budgetLimited: 'chat.goal.status.budgetLimited',
  complete: 'chat.goal.status.complete',
};

/** For a mark that stands alone: the status word needs its subject there. */
export const sessionGoalMarkLabelKey = {
  active: 'chat.goal.mark.active',
  paused: 'chat.goal.mark.paused',
  blocked: 'chat.goal.mark.blocked',
  budgetLimited: 'chat.goal.mark.budgetLimited',
  complete: 'chat.goal.mark.complete',
} satisfies Record<SessionGoalStatus, I18nKey>;
