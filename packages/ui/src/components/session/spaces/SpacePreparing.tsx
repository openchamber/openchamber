import React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';

/** What a panel of a draft waiting for a new space shows while the space is made: nothing of this computer's. */
export const SpacePreparing: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <Spinner className="h-4 w-4" />
      <span>{t('spaces.draft.preparing')}</span>
    </div>
  );
};
