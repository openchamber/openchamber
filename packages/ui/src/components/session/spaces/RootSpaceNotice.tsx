import { useI18n } from '@/lib/i18n';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';

export function RootSpaceWarning() {
  const { t } = useI18n();
  return <p role="alert" className="rounded-md bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error-text)]">
    {t('spaces.root.warning')}
  </p>;
}

export function RootSpaceBadge({ kind }: { readonly kind: SpaceEntry['kind'] | undefined }) {
  const { t } = useI18n();
  if (kind !== 'host-root') return null;
  return <span className="shrink-0 rounded bg-[var(--status-error-background)] px-1 py-0.5 typography-micro text-[var(--status-error-text)]">
    {t('spaces.root.badge')}
  </span>;
}
