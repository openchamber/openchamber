
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSpaceNameOf } from '@/lib/spaces/space-mark';
import { cn } from '@/lib/utils';

export const HeaderPlaceMark: React.FC<{ directory: string | null; branch: string | null; draft: boolean }> = ({ directory, branch, draft }) => {
  const { t } = useI18n();
  const spaceName = useSpaceNameOf(directory);
  const iconClass = cn('flex-shrink-0 text-muted-foreground', draft ? 'h-3.5 w-3.5' : 'h-3 w-3');
  const textClass = cn('truncate', draft && 'text-muted-foreground');
  if (spaceName) {
    return (
      <span className="inline-flex min-w-0 items-center gap-0.5" title={t('sessions.sidebar.group.space')}>
        <Icon name="instance" className={iconClass} />
        <span dir="auto" className={textClass}>{spaceName}</span>
      </span>
    );
  }
  if (!branch) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <Icon name="git-branch" className={iconClass} />
      <span dir="ltr" className={textClass}>{branch}</span>
    </span>
  );
};
