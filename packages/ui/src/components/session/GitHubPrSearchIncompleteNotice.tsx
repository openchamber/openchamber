import { useI18n } from '@/lib/i18n';

export function GitHubPrSearchIncompleteNotice() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="rounded-md border border-status-warning/20 bg-status-warning/10 px-2 py-1.5 typography-small text-status-warning"
    >
      {t('session.githubPrPicker.notice.incomplete')}
    </div>
  );
}
