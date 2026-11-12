import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  /** The committed sidebar query that matched nothing. */
  query: string;
  /** Whether the Archive page exists here; VS Code keeps its archive inline. */
  showArchive: boolean;
  resetSessionSearch: () => void;
};

/** The sidebar's no-match state, with a way to continue the same search in the Archive. */
export function SidebarSearchEmptyState({ query, showArchive, resetSessionSearch }: Props): React.ReactNode {
  const { t } = useI18n();
  const searchArchive = () => {
    useUIStore.getState().setArchivePageOpen(true, query);
    resetSessionSearch();
  };
  return (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
      {showArchive ? (
        <Button variant="link" size="xs" className="mt-2 h-auto p-0 typography-meta" onClick={searchArchive}>
          {t('sessions.sidebar.empty.noMatches.searchArchive')}
        </Button>
      ) : null}
    </div>
  );
}
