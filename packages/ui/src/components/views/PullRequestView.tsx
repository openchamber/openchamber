import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { useGitStatus, useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useShallow } from 'zustand/react/shallow';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { useRepositoryHost } from '@/components/references/referenceSources';
import { normalizePath } from '@/lib/pathNormalization';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { PullRequestSection } from './git/PullRequestSection';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { GitRepositoryUnreadableState } from './git/GitRepositoryUnreadableState';
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { deriveBaseBranch } from './git/baseBranch';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useBranchPullRequestBase } from '@/hooks/useBranchComparisonBase';

export const PullRequestView: React.FC = () => {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const { rootIsGitRepo, gitDirectory, nestedRepos, repositoryOptions, unreadable } = useNestedGitDirectory(currentDirectory ?? null, { recheckOnOpen: true });
  const status = useGitStatus(gitDirectory ?? null);
  const branches = useGitBranches(gitDirectory ?? null);
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const binding = useRepositoryBinding(gitDirectory, sourceControl);
  const { ensureAll, ensureNestedRepos, selectNestedRepo } = useGitStore(useShallow((state) => ({
    ensureAll: state.ensureAll,
    ensureNestedRepos: state.ensureNestedRepos,
    selectNestedRepo: state.selectNestedRepo,
  })));

  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
  const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
  const availableWorktrees = useSessionUIStore((s) => s.availableWorktrees);

  const normalizedCurrentDirectory = normalizePath(currentDirectory);
  const inferredWorktreeMetadata = React.useMemo(() => {
    if (!normalizedCurrentDirectory) {
      return undefined;
    }

    return findWorktreeHoldingDirectory(availableWorktrees, normalizedCurrentDirectory)
      ?? findWorktreeHoldingDirectory(worktreeMap.values(), normalizedCurrentDirectory);
  }, [availableWorktrees, normalizedCurrentDirectory, worktreeMap]);

  const storeWorktreeMetadata = React.useMemo(() => {
    if (currentSessionId) {
      return worktreeMap.get(currentSessionId) ?? inferredWorktreeMetadata;
    }

    if (newSessionDraft?.open) {
      return inferredWorktreeMetadata;
    }

    return undefined;
  }, [currentSessionId, inferredWorktreeMetadata, newSessionDraft?.open, worktreeMap]);

  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const authoritativeProjectRoot = worktreeAttachment && !worktreeAttachment.degraded && !worktreeAttachment.legacy
    ? worktreeAttachment.worktreeRoot ?? undefined
    : undefined;

  const worktreeMetadata = useDetectedWorktreeMetadata(currentDirectory, storeWorktreeMetadata, status?.current ?? undefined);

  React.useEffect(() => {
    if (!gitDirectory || !git) {
      return;
    }
    void ensureAll(gitDirectory, git);
  }, [gitDirectory, ensureAll, git]);

  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);
  React.useEffect(() => {
    const projectRoot = authoritativeProjectRoot || worktreeMetadata?.projectDirectory;
    if (!projectRoot) {
      setRootBranchHint(null);
      return;
    }

    let cancelled = false;
    void getRootBranch(projectRoot)
      .then((branch) => {
        if (cancelled) return;
        const normalized = branch.trim();
        setRootBranchHint(normalized && normalized !== 'HEAD' ? normalized : null);
      })
      .catch(() => {
        if (!cancelled) {
          setRootBranchHint(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authoritativeProjectRoot, worktreeMetadata?.projectDirectory]);

  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);

  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);

  const currentBranch = status?.current ?? null;

  const defaultBranch = React.useMemo(() => {
    const primaryRemote = binding.contexts[0]?.primaryRemote;
    return primaryRemote ? branches?.defaultBranches?.[primaryRemote] : undefined;
  }, [binding.contexts, branches]);

  const derivedBaseBranch = React.useMemo(() => deriveBaseBranch({
    remoteNames: new Set(binding.contexts[0]?.primaryRemote ? [binding.contexts[0].primaryRemote] : []),
    knownRemoteNames: new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
    localBranches,
    worktreeCreatedFromBranch: worktreeMetadata?.createdFromBranch,
    rootBranchHint,
    defaultBranch,
    headBranch: currentBranch,
    fallbackToConventional: false,
  }), [
    currentBranch,
    defaultBranch,
    binding.contexts,
    binding.read,
    localBranches,
    rootBranchHint,
    worktreeMetadata?.createdFromBranch,
  ]);
  const baseBranch = useBranchPullRequestBase(gitDirectory ?? null, currentBranch, true, binding, branches, derivedBaseBranch);

  const changeRequestTerm = useChangeRequestTerm(useRepositoryHost(currentDirectory ?? null)?.provider);

  if (!currentDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t(changeRequestCopy('gitView.pullRequest.title', changeRequestTerm))}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t(changeRequestCopy('gitView.pullRequest.createHint', changeRequestTerm))}</div>
      </div>
    );
  }

  if (unreadable) {
    return <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />;
  }

  if (rootIsGitRepo === false && isGitRepo !== true) {
    return (
      <NestedRepoResolutionStates
        root={currentDirectory}
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          void ensureNestedRepos(currentDirectory, { force: true });
        }}
      />
    );
  }

  if (!currentBranch) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t(changeRequestCopy('gitView.pullRequest.title', changeRequestTerm))}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t(changeRequestCopy('gitView.pullRequest.createHint', changeRequestTerm))}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {repositoryOptions ? (
        <div className="flex shrink-0 items-center border-b border-edge px-4 py-2">
          <NestedRepoPicker
            repositories={repositoryOptions}
            selectedRepository={gitDirectory ?? null}
            onSelectRepository={(repository) => {
              if (currentDirectory) selectNestedRepo(currentDirectory, repository);
            }}
            repositoryRoot={currentDirectory ?? undefined}
          />
        </div>
      ) : null}
      <ScrollableOverlay
        as={ScrollShadow}
        outerClassName="h-full min-h-0 flex-1"
        className="h-full"
        disableHorizontal
        preventOverscroll
      >
        <PullRequestSection
          directory={gitDirectory ?? currentDirectory}
          branch={currentBranch}
          baseBranch={baseBranch}
          trackingBranch={status?.tracking ?? undefined}
          ahead={status?.ahead ?? 0}
          remoteBranches={remoteBranches}
        />
      </ScrollableOverlay>
    </div>
  );
};
