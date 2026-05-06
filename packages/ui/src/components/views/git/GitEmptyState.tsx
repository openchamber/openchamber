import React from 'react';
import { RiArchiveStackLine, RiGitCommitLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface GitEmptyStateProps {
  onOpenStashes?: () => void;
}

export const GitEmptyState: React.FC<GitEmptyStateProps> = ({ onOpenStashes }) => {
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

      {onOpenStashes ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenStashes}
          className="gap-1.5"
        >
          <RiArchiveStackLine className="size-4" />
          {t('gitView.stashes.title')}
        </Button>
      ) : null}
    </div>
  );
};
