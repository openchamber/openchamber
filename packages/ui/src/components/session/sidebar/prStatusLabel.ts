import type { useI18n } from '@/lib/i18n';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { getPrStatusLabelKey } from './sessions/sessionPrSummaries';

export function getPrStatusLabel(pr: PrVisualSummary | null, t: ReturnType<typeof useI18n>['t']): string | null {
  if (!pr) return null;
  const labelKey = getPrStatusLabelKey(pr);
  if (!labelKey) return null;
  // Conflicts win the status line; failing checks on top of them still get named.
  return labelKey === 'sessions.sidebar.group.pr.status.mergeConflicts' && pr.checks?.state === 'failure'
    ? `${t(labelKey)} · ${t('chat.chatInput.prCheckContext')}`
    : t(labelKey);
}
