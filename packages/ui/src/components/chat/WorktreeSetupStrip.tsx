import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/**
 * Says the worktree is still running its setup commands, above the composer,
 * so a first prompt that waits on them does not look stuck. The composer shows
 * it only while setup runs.
 */
export const WorktreeSetupStrip: React.FC = React.memo(() => {
  const { t } = useI18n();
  return (
    <div role="status" className="border-b border-border/60">
      <div className="flex h-10 items-center gap-2 pl-3 pr-3">
        <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{t('chat.worktreeSetup.running')}</span>
      </div>
    </div>
  );
});

WorktreeSetupStrip.displayName = 'WorktreeSetupStrip';
