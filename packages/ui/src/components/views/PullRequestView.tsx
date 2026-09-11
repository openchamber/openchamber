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
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GitRemote } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { PullRequestSection } from './git/PullRequestSection';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { deriveBaseBranch } from './git/baseBranch';

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

// Remotes rarely change; remembering the last fetched list per directory lets
// a remount pick the same PR-status key immediately instead of flashing
// through the remote-less "checking status" state while remotes reload.
// Runtime-scoped so a backend switch never serves another runtime's remotes.
const remotesCacheByDirectory = new Map<string, GitRemote[]>();
const remoteUrlCacheByDirectory = new Map<string, string | null>();
const remoteCacheKey = (directory: string): string => `${getRuntimeKey()}::${directory}`;

/**
 * Standalone pull-request surface: resolves the same repository context
 * GitView does (branch, base branch, remotes) from the shared git stores and
 * renders the pull-request workflow full-size in the context panel.
 */
export const PullRequestView: React.FC = () => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  // When the root is not itself a repository, the pull-request workflow
  // operates on the resolved nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(currentDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);
  const branches = useGitBranches(gitDirectory ?? null);
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
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

    const fromAvailable = availableWorktrees.find(
      (metadata) => normalizePath(metadata.path) === normalizedCurrentDirectory
    );
    if (fromAvailable) {
      return fromAvailable;
    }

    for (const metadata of worktreeMap.values()) {
      if (normalizePath(metadata.path) === normalizedCurrentDirectory) {
        return metadata;
      }
    }

    return undefined;
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

  const [remotes, setRemotes] = React.useState<GitRemote[]>(() =>
    (gitDirectory ? remotesCacheByDirectory.get(remoteCacheKey(gitDirectory)) : undefined) ?? []
  );
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(() =>
    (gitDirectory ? remoteUrlCacheByDirectory.get(remoteCacheKey(gitDirectory)) : undefined) ?? null
  );
  React.useEffect(() => {
    if (!gitDirectory || !git?.getRemotes) {
      setRemotes([]);
      return;
    }

    setRemotes(remotesCacheByDirectory.get(remoteCacheKey(gitDirectory)) ?? []);
    let cancelled = false;
    void git.getRemotes(gitDirectory)
      .then((remoteList) => {
        if (cancelled) return;
        remotesCacheByDirectory.set(remoteCacheKey(gitDirectory), remoteList ?? []);
        setRemotes(remoteList ?? []);
      })
      .catch(() => { if (!cancelled) setRemotes(remotesCacheByDirectory.get(remoteCacheKey(gitDirectory)) ?? []); });

    return () => {
      cancelled = true;
    };
  }, [gitDirectory, git]);

  React.useEffect(() => {
    if (!gitDirectory || !git?.getRemoteUrl) {
      setRemoteUrl(null);
      return;
    }

    setRemoteUrl(remoteUrlCacheByDirectory.get(remoteCacheKey(gitDirectory)) ?? null);
    let cancelled = false;
    void git.getRemoteUrl(gitDirectory)
      .then((url) => {
        if (cancelled) return;
        remoteUrlCacheByDirectory.set(remoteCacheKey(gitDirectory), url);
        setRemoteUrl(url);
      })
      .catch(() => { if (!cancelled) setRemoteUrl(remoteUrlCacheByDirectory.get(remoteCacheKey(gitDirectory)) ?? null); });

    return () => {
      cancelled = true;
    };
  }, [gitDirectory, git]);

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

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) {
      return remotes;
    }

    const inferredNames = new Set<string>();
    const tracking = status?.tracking?.trim();
    if (tracking && tracking.includes('/')) {
      inferredNames.add(tracking.split('/')[0]);
    }

    for (const branchName of remoteBranches) {
      const slashIndex = branchName.indexOf('/');
      if (slashIndex > 0) {
        inferredNames.add(branchName.slice(0, slashIndex));
      }
    }

    if (inferredNames.size === 0 && remoteUrl) {
      inferredNames.add('origin');
    }

    return Array.from(inferredNames).map((name) => ({
      name,
      fetchUrl: remoteUrl ?? '',
      pushUrl: remoteUrl ?? '',
    }));
  }, [remotes, remoteBranches, remoteUrl, status?.tracking]);

  const currentBranch = status?.current ?? null;

  // A pull request opened against a branch that does not exist is worse than a
  // broken walkthrough, so this surface reads the repository's default branch
  // too rather than guessing at main/master/develop.
  const defaultBranch = React.useMemo(() => {
    const trackingRemote = status?.tracking?.trim().split('/')[0];
    return (trackingRemote && branches?.defaultBranches?.[trackingRemote])
      ?? branches?.defaultBranches?.origin;
  }, [branches, status?.tracking]);

  const baseBranch = React.useMemo(() => deriveBaseBranch({
    remoteNames: new Set(effectiveRemotes.map((remote) => remote.name)),
    localBranches,
    worktreeCreatedFromBranch: worktreeMetadata?.createdFromBranch,
    rootBranchHint,
    defaultBranch,
    headBranch: currentBranch,
  }), [
    currentBranch,
    defaultBranch,
    effectiveRemotes,
    localBranches,
    rootBranchHint,
    worktreeMetadata?.createdFromBranch,
  ]);

  if (!currentDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('gitView.pullRequest.title')}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t('gitView.pullRequest.createHint')}</div>
      </div>
    );
  }

  // Non-repo root: surface nested-repository resolution while the operating
  // directory has not proven to be a repository (discovering, failed,
  // unsupported, none found, or settling on the auto-selected one).
  if (rootIsGitRepo === false && isGitRepo !== true) {
    return (
      <NestedRepoResolutionStates
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
        <div className="typography-ui-header text-foreground">{t('gitView.pullRequest.title')}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t('gitView.pullRequest.createHint')}</div>
      </div>
    );
  }

  // Repository switcher for non-repo roots with discovered nested
  // repositories; the pick is shared per root across git surfaces.
  const showRepositoryPicker =
    rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showRepositoryPicker ? (
        <div className="flex shrink-0 items-center border-b border-border/60 px-4 py-2">
          <NestedRepoPicker
            repositories={nestedRepos}
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
        className="px-4 py-3"
        disableHorizontal
        preventOverscroll
      >
        <PullRequestSection
          directory={gitDirectory ?? currentDirectory}
          branch={currentBranch}
          baseBranch={baseBranch}
          trackingBranch={status?.tracking ?? undefined}
          remotes={remotes}
          remoteBranches={remoteBranches}
        />
      </ScrollableOverlay>
    </div>
  );
};
