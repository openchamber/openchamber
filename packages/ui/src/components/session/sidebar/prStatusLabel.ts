import type { useI18n } from '@/lib/i18n';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { getPrStatusLabelKey } from './sessions/sessionPrSummaries';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';

/** The status line of a change request, in the words of its provider's `term`. */
export function getPrStatusLabel(pr: PrVisualSummary | null, term: ChangeRequestTerm, t: ReturnType<typeof useI18n>['t']): string | null {
  if (!pr) return null;
  const labelKey = getPrStatusLabelKey(pr);
  if (!labelKey) return null;
  // Conflicts win the status line; failing checks on top of them still get named.
  const label = t(changeRequestCopy(labelKey, term));
  return labelKey === 'sessions.sidebar.group.pr.status.mergeConflicts' && pr.checks?.state === 'failure'
    ? `${label} · ${t(changeRequestCopy('chat.chatInput.prCheckContext', term))}`
    : label;
}
