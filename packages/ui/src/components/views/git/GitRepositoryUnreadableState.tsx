import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';

type GitRepositoryUnreadableStateProps = {
  /** The directory Git could not read; the retry checks it again. */
  directory: string;
  /** Git's own message (`GIT_REPOSITORY_UNREADABLE`). */
  message: string;
};

/**
 * Git could not tell whether `directory` is a repository: it is not
 * startable, refused the directory (`safe.directory`), or timed out. Git's own
 * words are shown, since a refusal names the command that fixes it, with a
 * retry and without "Initialize Git": initializing over a repository Git
 * could not read is the wrong fix.
 */
export const GitRepositoryUnreadableState: React.FC<GitRepositoryUnreadableStateProps> = ({ directory, message }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const recheckRepository = useGitStore((state) => state.recheckRepository);
  const [retrying, setRetrying] = React.useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await recheckRepository(directory, git);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <Icon name="git-branch" className="mb-3 size-6 text-muted-foreground" />
      <p className="typography-ui-label font-semibold text-foreground">
        {t('gitView.empty.repositoryUnreadable')}
      </p>
      <p className="typography-meta mt-1 text-muted-foreground">
        {t('gitView.empty.repositoryUnreadableDescription')}
      </p>
      <ScrollableOverlay
        outerClassName="mt-3 max-h-40 w-full max-w-md rounded-lg oc-tile-inset"
        className="select-text p-3 text-start font-mono typography-micro text-foreground whitespace-pre-wrap break-words"
        disableHorizontal
      >
        {message}
      </ScrollableOverlay>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 gap-1.5"
        onClick={() => void retry()}
        disabled={retrying}
      >
        <Icon name="refresh" className="size-4" />
        {t('gitView.empty.repositoryUnreadableRetry')}
      </Button>
    </div>
  );
};
