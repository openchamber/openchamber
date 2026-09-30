import type { useI18n } from '@/lib/i18n';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';

export function getPrStatusLabel(pr: PrVisualSummary | null, t: ReturnType<typeof useI18n>['t']): string | null {
  if (!pr) return null;
  switch (pr.visualState) {
    case 'merged':
      return t('sessions.sidebar.group.pr.status.merged');
    case 'open':
      return (pr.canMerge === true || pr.mergeableState === 'clean' || pr.checks?.state === 'success')
        ? t('sessions.sidebar.group.pr.status.readyToMerge')
        : t('sessions.sidebar.group.pr.status.open');
    case 'blocked':
      return [
        pr.mergeableState === 'dirty'
          ? t('sessions.sidebar.group.pr.status.mergeConflicts')
          : t('sessions.sidebar.group.pr.status.mergeBlocked'),
        pr.checks?.state === 'failure' ? t('chat.chatInput.prCheckContext') : null,
      ].filter(Boolean).join(' · ');
    case 'draft':
      return t('sessions.sidebar.group.pr.status.draft');
    case 'closed':
      return t('sessions.sidebar.group.pr.status.closed');
    default:
      return null;
  }
}
