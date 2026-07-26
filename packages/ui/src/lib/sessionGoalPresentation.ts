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
