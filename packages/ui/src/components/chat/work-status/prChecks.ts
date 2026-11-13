import type { useI18n } from '@/lib/i18n';
import type { CISummary } from '@/lib/source-control/types';

export type PrChecks = Pick<CISummary, 'total' | 'success' | 'failure' | 'pending'>;

/** Red once any check failed, yellow while any still runs, green when all passed. */
export const prChecksDotColor = (checks: PrChecks): string => {
  if (checks.failure > 0) return 'var(--status-error)';
  if (checks.pending > 0) return 'var(--status-warning)';
  return 'var(--status-success)';
};

/** The per-state counts the row's value leaves out, for its tooltip. */
export const prChecksTooltip = (checks: PrChecks, t: ReturnType<typeof useI18n>['t']): string => [
  checks.failure > 0 ? t('chat.workStatus.pr.checksFailed', { count: checks.failure }) : null,
  checks.pending > 0 ? t('chat.workStatus.pr.checksPending', { count: checks.pending }) : null,
  checks.success > 0 ? t('chat.workStatus.pr.checksPassed', { count: checks.success }) : null,
].filter(Boolean).join(' · ');
