import React from 'react';
import { useI18n } from '@/lib/i18n';

/** Nothing matched: the search already covered active and archived sessions. */
export function SidebarSearchEmptyState(): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  );
}
