import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { GitLogEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

import { CommitActionsDropdown } from './CommitListPanel';
import { GitDrillHeader } from './GitDrillHeader';
import type { CommitActionsController } from './useCommitActions';

export const CommitDrillHeader: React.FC<{
  hash: string;
  commit: GitLogEntry | null;
  actions: CommitActionsController;
  focusOnMount: boolean;
  onFocused: () => void;
  onBack: () => void;
  onCopyHash: (hash: string) => void;
}> = ({ hash, commit, actions, focusOnMount, onFocused, onBack, onCopyHash }) => {
  const { t } = useI18n();
  return (
    <GitDrillHeader
      backLabel={t('commitComparison.backToList')}
      onBack={onBack}
      focusOnMount={focusOnMount}
      onFocused={onFocused}
      title={commit?.message ?? hash.slice(0, 8)}
      meta={(
        <>
          {commit ? <><span className="truncate">{commit.author_name}</span><span>·</span></> : null}
          <button
            type="button"
            onClick={() => onCopyHash(hash)}
            className="inline-flex shrink-0 items-center gap-1 font-mono hover:text-foreground"
            title={t('gitView.history.copySha')}
          >
            {hash.slice(0, 8)}
            <Icon name="file-copy" className="size-3" />
          </button>
        </>
      )}
      actions={commit ? <CommitActionsDropdown entry={commit} actions={actions} /> : undefined}
    />
  );
};
