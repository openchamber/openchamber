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
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { deriveBaseBranch } from './git/baseBranch';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useBranchPullRequestBase } from '@/hooks/useBranchComparisonBase';

// Remotes rarely change; remembering the last fetched list per directory lets
// a remount pick the same PR-status key immediately instead of flashing
// through the remote-less "checking status" state while remotes reload.
// Runtime-scoped so a backend switch never serves another runtime's remotes.
/**
 * Standalone pull-request surface: resolves the same repository context
 * GitView does (branch, base branch, remotes) from the shared git stores and
 * renders the pull-request workflow full-size in the context panel.
 */
export const PullRequestView: React.FC = () => {
  const { t } = useI18n();
  const { git, sourceControl } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  // When the root is not itself a repository, the pull-request workflow
  // operates on the resolved nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos, repositoryOptions } = useNestedGitDirectory(currentDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);
  const branches = useGitBranches(gitDirectory ?? null);
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  // The binding follows the repository actually in view.
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

  // A pull request opened against a branch that does not exist is worse than a
  // broken walkthrough, so this surface reads the repository's default branch
  // too rather than guessing at main/master/develop.
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
  // The branch's own parent (a chosen base, its pull request's target, the
  // layer below it in a stack) wins over the worktree's guess.
  const baseBranch = useBranchPullRequestBase(gitDirectory ?? null, currentBranch, true, binding, branches, derivedBaseBranch);

  // Empty states name the host's own kind of change request.
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

  // Non-repo root: surface nested-repository resolution while the operating
  // directory has not proven to be a repository (discovering, failed,
  // unsupported, none found, or settling on the auto-selected one).
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

  // Repository switcher; the pick is shared per root across git surfaces.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {repositoryOptions ? (
        <div className="flex shrink-0 items-center border-b border-border/60 px-4 py-2">
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
        // The section pads its own form; an open PR's preview fills the panel.
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
