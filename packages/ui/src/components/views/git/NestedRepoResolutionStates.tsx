import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { NestedRepoDiscovery } from '@/stores/useGitStore';

type NestedRepoResolutionStatesProps = {
  /** Probe of the project root: `false` means nested resolution applies. */
  rootIsGitRepo: boolean | null;
  /**
   * Probe of the directory the consumer operates on (root or selected nested
   * repository). `true` means resolution succeeded and the consumer should
   * render its own content.
   */
  resolvedIsGitRepo: boolean | null;
  /** Discovery outcome for the root (`undefined` = not run yet). */
  nestedRepos: NestedRepoDiscovery | undefined;
  onRetryDiscovery: () => void;
  /** Optional extra line under the not-a-repository description. */
  emptyStateFooter?: React.ReactNode;
};

/**
 * Shared empty/loading states for git surfaces while nested-repository
 * resolution is pending, failed, or impossible. Renders null once resolution
 * has finished — either the root is a repository or the operating directory
 * probed as one — so the consumer can proceed into its own content.
 *
 * A runtime without the discovery route (VS Code) reports "unsupported": the
 * honest state there is the plain not-a-repository empty state, without a
 * retry that can never succeed.
 */
export const NestedRepoResolutionStates: React.FC<NestedRepoResolutionStatesProps> = ({
  rootIsGitRepo,
  resolvedIsGitRepo,
  nestedRepos,
  onRetryDiscovery,
  emptyStateFooter,
}) => {
  const { t } = useI18n();

  if (rootIsGitRepo !== false) return null;
  if (resolvedIsGitRepo === true) return null;

  if (nestedRepos === undefined || nestedRepos === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <Icon name="loader-4" className="mb-3 size-6 animate-spin text-muted-foreground" />
        <p className="typography-ui-label font-semibold text-foreground">
          {nestedRepos === null
            ? t('gitView.empty.discoverFailed')
            : t('gitView.empty.discoveringRepositories')}
        </p>
        {nestedRepos === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 gap-1.5"
            onClick={onRetryDiscovery}
          >
            <Icon name="refresh" className="size-4" />
            {t('gitView.empty.retryDiscovery')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (nestedRepos === 'unsupported' || nestedRepos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <Icon name="git-branch" className="mb-3 size-6 text-muted-foreground" />
        <p className="typography-ui-label font-semibold text-foreground">
          {t('gitView.empty.notGitRepository')}
        </p>
        <p className="typography-meta mt-1 text-muted-foreground">
          {t('gitView.empty.notGitRepositoryDescription')}
        </p>
        {emptyStateFooter}
      </div>
    );
  }

  // Repositories were found and one is about to be auto-selected (or the
  // selected repository is still probing) — hold a brief loading state.
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <Icon name="loader-4" className="mb-3 size-6 animate-spin text-muted-foreground" />
      <p className="typography-ui-label font-semibold text-foreground">
        {t('gitView.loading.checkingRepository')}
      </p>
    </div>
  );
};
