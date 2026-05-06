import React from 'react';
import { RiGitCommitLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';

export const GitEmptyState: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <RiGitCommitLine className="size-10 text-muted-foreground/70 mb-4" />
      <p className="typography-ui-label font-semibold text-foreground mb-1">
        {t('gitView.empty.cleanTitle')}
      </p>
      <p className="typography-meta text-muted-foreground mb-4">
        {t('gitView.empty.cleanDescription')}
      </p>
    </div>
  );
};
