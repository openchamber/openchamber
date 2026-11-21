import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import type { GitIdentityProfile, CommitFileEntry, GitStatus } from '@/lib/api/types';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitmojiList } from '@/hooks/useGitmojiList';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useGitIdentity,
  useIsGitRepo,
  useGitLoadingStatus,
  useGitLoadingLog,
} from '@/stores/useGitStore';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { NestedRepoResolutionStates } from './git/NestedRepoResolutionStates';
import { GitRepositoryUnreadableState } from './git/GitRepositoryUnreadableState';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from "@/components/ui/spinner";
import { Button } from '@/components/ui/button';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getSessionWorktreeRepairActions, getMutationBlockingReasons } from '@/sync/session-worktree-contract';
import { IntegrateCommitsSection } from './git/IntegrateCommitsSection';

import { GitHeader } from './git/GitHeader';
import { gitRequestErrorMessage } from './git/gitRequestErrorMessage';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { StashesDialog } from './git/StashesDialog';
import { ChangesPanel, type ChangesGroupConfig } from './git/ChangesPanel';
import { CommitSection } from './git/CommitSection';
import { GitEmptyState } from './git/GitEmptyState';
import { HistorySection } from './git/HistorySection';
import { ConflictDialog } from './git/ConflictDialog';
import { StashDialog } from './git/StashDialog';
import { DirtyBranchSwitchDialog } from './git/DirtyBranchSwitchDialog';
import { InProgressOperationBanner } from './git/InProgressOperationBanner';
import { BranchIntegrationSection, type OperationLogEntry } from './git/BranchIntegrationSection';
import {
  createRemoteBranchIntegrationTargets,
  resolveBranchIntegrationRef,
  type BranchIntegrationRemoteBranch,
  type BranchIntegrationTarget,
} from './git/branchIntegration';
import { deriveBaseBranch } from './git/baseBranch';
import { isConflictedStatusFile } from './git/changeStatus';
import { getFreshestSourceControlStatusForBranch, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore, useConnectedAccountIds } from '@/stores/useSourceControlAuthStore';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useBranchPullRequestBase } from '@/hooks/useBranchComparisonBase';
import { useBranchPullRequestRequest } from '@/hooks/useBranchPullRequestRequest';
import { hasConfigChangedGrant } from '@/lib/source-control/types';
import { createGitIndexMutationQueue, type GitIndexMutationDirection, type GitIndexMutationQueue } from './git/gitIndexMutationQueue';
import type { GitRemote } from '@/lib/gitApi';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import { cn } from '@/lib/utils';
import { generateCommitMessage as generateSessionCommitMessage, getGitWorktreeBootstrapStatus } from '@/lib/gitApi';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';
import { useCommitCelebration } from './git/useCommitCelebration';
import { BoundGitNetworkOperationError, GitOperationResultError, runBoundGitNetworkOperation, runContributorAwarePush, describeGitSyncOutcome, type GitSyncOutcome } from '@/lib/boundGitNetworkOperation';
import { useGitOperationRecovery } from './git/useGitOperationRecovery';
import { GitOperationStatus } from './git/GitOperationStatus';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';
import { useGitPublishChooser } from './git/useGitPublishChooser';
import { PublishDialog } from './git/PublishDialog';
import { ContributorDestinationDialog } from './git/ContributorDestinationDialog';
import { useContributorDestinationChooser } from './git/contributorDestination';
import { RepositoryConfigurationDialog } from '@/components/sections/openchamber/SourceControlBindingSettings';
import { applyIdentityToRepository, identityApplicability, type IdentityApplicability } from '@/lib/source-control/applyIdentity';
import { instanceSshHostsFrom, remoteTraits, identityDisplayName } from '@/lib/source-control/identity';
import { activeAuthor, offeredAuthors } from './git/gitAuthors';
import { dirtySwitchPushTarget } from './git/dirtySwitchPushTarget';
import { mapWithConcurrency } from '@/lib/concurrency';

type SyncAction = 'fetch' | 'pull' | 'sync' | 'publish' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;
type BranchOperation = 'merge' | 'rebase' | null;
type GitLogDialogMode = 'history' | 'graph';
type HistoryBranchDivider = {
  insertBeforeIndex: number;
  branchName: string;
  direction: 'up' | 'down';
} | null;

const GIT_RECONCILE_DELAY_MS = 15000;

type GitViewSnapshot = {
  directory?: string;
  commitMessage: string;
  generatedHighlights: string[];
};

type GitmojiEntry = {
  emoji: string;
  code: string;
  description: string;
};

const GIT_DIFF_PRIORITY_PREFETCH_LIMIT = 40;
const GIT_DIFF_PRIORITY_BASELINE_LIMIT = 20;

const REVERT_PATHS_CONCURRENCY = 2;

const KEYWORD_MAP: Record<string, string> = {
  'feat': ':sparkles:',
  'feature': ':sparkles:',
  'fix': ':bug:',
  'bug': ':bug:',
  'hotfix': ':ambulance:',
  'docs': ':memo:',
  'documentation': ':memo:',
  'style': ':lipstick:',
  'refactor': ':recycle:',
  'perf': ':zap:',
  'performance': ':zap:',
  'test': ':white_check_mark:',
  'tests': ':white_check_mark:',
  'build': ':construction_worker:',
  'ci': ':green_heart:',
  'chore': ':wrench:',
  'revert': ':rewind:',
  'wip': ':construction:',
  'security': ':lock:',
  'release': ':bookmark:',
  'merge': ':twisted_rightwards_arrows:',
  'mv': ':truck:',
  'move': ':truck:',
  'rename': ':truck:',
  'remove': ':fire:',
  'delete': ':fire:',
  'add': ':sparkles:',
  'create': ':sparkles:',
  'implement': ':sparkles:',
  'update': ':recycle:',
  'improve': ':zap:',
  'optimize': ':zap:',
  'upgrade': ':arrow_up:',
  'downgrade': ':arrow_down:',
  'deploy': ':rocket:',
  'init': ':tada:',
  'initial': ':tada:',
};

const matchGitmojiFromSubject = (subject: string, gitmojis: GitmojiEntry[]): GitmojiEntry | null => {
  const lowerSubject = subject.toLowerCase();

  const conventionalRegex = /^([a-z]+)(?:\(.*\))?!?:/;
  const match = lowerSubject.match(conventionalRegex);

  if (match) {
    const type = match[1];
    const mappedCode = KEYWORD_MAP[type];
    if (mappedCode) {
      return gitmojis.find((g) => g.code === mappedCode) || null;
    }
  }

  const firstWord = lowerSubject.split(' ')[0];
  const mappedCode = KEYWORD_MAP[firstWord];
  if (mappedCode) {
    return gitmojis.find((g) => g.code === mappedCode) || null;
  }

  return null;
};

const GIT_VIEW_SNAPSHOTS_CAP = 20;

const gitViewSnapshots = new Map<string, GitViewSnapshot>();

const rememberSnapshot = (key: string, snapshot: GitViewSnapshot) => {
  gitViewSnapshots.delete(key);
  gitViewSnapshots.set(key, snapshot);
  if (gitViewSnapshots.size > GIT_VIEW_SNAPSHOTS_CAP) {
    const oldest = gitViewSnapshots.keys().next().value;
    if (oldest !== undefined) {
      gitViewSnapshots.delete(oldest);
    }
  }
};

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

type GitViewProps = {
  isActive: boolean;
};

export const GitView: React.FC<GitViewProps> = ({ isActive }) => {
  const [opening, setOpening] = React.useState({ active: isActive, count: 0 });
  if (opening.active !== isActive) setOpening({ active: isActive, count: opening.count + (isActive ? 1 : 0) });
  const { t } = useI18n();
  const { git, sourceControl, runtime } = useRuntimeAPIs();
  const panelDirectory = useEffectiveDirectory();
  const draftSpace = useDraftSpaceTarget();
  const currentDirectory = panelContentDirectory(draftSpace, panelDirectory) ?? undefined;
  const contributorDestination = useContributorDestinationChooser();
  const [worktreeBootstrapSnapshot, setWorktreeBootstrapSnapshot] = React.useState<{
    directory: string;
    status: 'pending' | 'ready' | 'failed' | null;
  } | null>(null);
  const [postBootstrapRefresh, setPostBootstrapRefresh] = React.useState<{
    directory: string;
    status: 'refreshing' | 'failed';
  } | null>(null);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
  const setDraftBootstrapPendingDirectory = useSessionUIStore((s) => s.setDraftBootstrapPendingDirectory);
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

  const { profiles, globalIdentity, defaultGitIdentityId, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId } =
    useGitIdentitiesStore(useShallow((s) => ({
      profiles: s.profiles,
      globalIdentity: s.globalIdentity,
      defaultGitIdentityId: s.defaultGitIdentityId,
      loadProfiles: s.loadProfiles,
      loadGlobalIdentity: s.loadGlobalIdentity,
      loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    })));

  const { rootIsGitRepo, gitDirectory, nestedRepos, repositoryOptions, unreadable } = useNestedGitDirectory(
    currentDirectory ?? null,
    { enabled: isActive, recheckOnOpen: true },
  );
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);
  const publishChooser = useGitPublishChooser({ directory: gitDirectory, branch: status?.current, chooseContributor: contributorDestination.choose });
  const operationRecovery = useGitOperationRecovery(gitDirectory, git, sourceControl);

  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const repairActions = worktreeAttachment ? getSessionWorktreeRepairActions(worktreeAttachment) : [];

  const authoritativeProjectRoot = worktreeAttachment && !worktreeAttachment.degraded && !worktreeAttachment.legacy
    ? worktreeAttachment.worktreeRoot ?? undefined
    : undefined;

  const worktreeMetadata = useDetectedWorktreeMetadata(currentDirectory, storeWorktreeMetadata, status?.current ?? undefined);
  const branches = useGitBranches(gitDirectory ?? null);
  const log = useGitLog(gitDirectory ?? null);
  const currentIdentity = useGitIdentity(gitDirectory ?? null);
  const isLoading = useGitLoadingStatus(gitDirectory ?? null);
  const isLogLoading = useGitLoadingLog(gitDirectory ?? null);
  const {
    setActiveDirectory,
    ensureAll,
    fetchStatus,
    fetchBranches,
    fetchLog,
    setLogMaxCount,
    fetchIdentity,
    prefetchDiffs,
    clearDiffCache,
    moveStatusPathsOptimistically,
    restoreStatus,
    bumpIndexRevision,
    ensureNestedRepos,
    selectNestedRepo,
  } = useGitStore(useShallow((state) => ({
    setActiveDirectory: state.setActiveDirectory,
    ensureAll: state.ensureAll,
    fetchStatus: state.fetchStatus,
    fetchBranches: state.fetchBranches,
    fetchLog: state.fetchLog,
    setLogMaxCount: state.setLogMaxCount,
    fetchIdentity: state.fetchIdentity,
    prefetchDiffs: state.prefetchDiffs,
    clearDiffCache: state.clearDiffCache,
    moveStatusPathsOptimistically: state.moveStatusPathsOptimistically,
    restoreStatus: state.restoreStatus,
    bumpIndexRevision: state.bumpIndexRevision,
    ensureNestedRepos: state.ensureNestedRepos,
    selectNestedRepo: state.selectNestedRepo,
  })));
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextDiff = useUIStore((state) => state.openContextDiff);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const binding = useRepositoryBinding(gitDirectory, sourceControl, isActive);
  const [isRepositoryConfigurationOpen, setRepositoryConfigurationOpen] = React.useState(false);
  const identityAttention = React.useMemo(() => {
    const read = binding.read;
    if (!read?.binding || binding.status !== 'ready' || read.binding.state === 'bound') return null;
    return hasConfigChangedGrant(read.binding)
      ? t('gitView.identity.configChanged')
      : t('gitView.context.needsAttention');
  }, [binding.read, binding.status, t]);
  const bindingRemoteName = binding.read?.binding?.remotes[0]?.name
    ?? binding.read?.repository.remotes.find((remote) => remote.name === 'origin')?.name
    ?? binding.read?.repository.remotes[0]?.name
    ?? '';
  const sourceControlIdentities = useSourceControlAuthStore((state) => state.identities);
  const instanceSshHosts = React.useMemo(() => instanceSshHostsFrom(sourceControlIdentities), [sourceControlIdentities]);
  const identityApplicabilityOf = React.useCallback((identity: GitIdentityProfile): IdentityApplicability => {
    const remote = binding.read?.repository.remotes.find((entry) => entry.name === bindingRemoteName);
    return remote ? identityApplicability(identity, remoteTraits(remote.fetch.displayUrl), instanceSshHosts) : { applicable: true };
  }, [binding.read, bindingRemoteName, instanceSshHosts]);
  const sourceControlAuthEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshIdentityAccounts = useSourceControlAuthStore((state) => state.refreshIdentityAccounts);
  const beginActiveSourceControlContextsLoad = useGitHubPrStatusStore((state) => state.beginActiveContextsLoad);
  const commitActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.commitActiveContexts);
  const releaseActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.releaseActiveContexts);
  const sourceControlContextsOwnerId = React.useId();
  React.useEffect(() => {
    if (!isActive || !currentDirectory) return;
    const capturedRuntimeKey = binding.scope.runtimeKey;
    const contextRequestId = beginActiveSourceControlContextsLoad(
      capturedRuntimeKey,
      currentDirectory,
      sourceControlContextsOwnerId,
    );
    commitActiveSourceControlContexts(
      capturedRuntimeKey, currentDirectory, sourceControlContextsOwnerId, contextRequestId,
      binding.contexts.filter((context) => getSourceControlReadContextAuthState(
        sourceControlAuthEntries[getSourceControlAuthKey(context)], context,
      ).connected),
    );
    return () => {
      releaseActiveSourceControlContexts(capturedRuntimeKey, currentDirectory, sourceControlContextsOwnerId);
    };
  }, [beginActiveSourceControlContextsLoad, binding.contexts, binding.scope.runtimeKey, commitActiveSourceControlContexts, currentDirectory, isActive, releaseActiveSourceControlContexts, sourceControlAuthEntries, sourceControlContextsOwnerId]);
  const prReadContext = binding.contexts[0] ?? null;

  const prStatusBranch = status?.current ?? null;
  const prChipStatus = useGitHubPrStatusStore((state) => {
    if (!prStatusBranch || !prReadContext || !getSourceControlReadContextAuthState(
      sourceControlAuthEntries[getSourceControlAuthKey(prReadContext)], prReadContext,
    ).connected) {
      return null;
    }
    return getFreshestSourceControlStatusForBranch(state.entries, prReadContext, prStatusBranch);
  });
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  const gitReconcileTimeoutRef = React.useRef<number | null>(null);
  const gitMutationFlushTimeoutRef = React.useRef<number | null>(null);
  const flushQueuedGitMutationsRef = React.useRef<(() => void) | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const clearScheduledGitReconcile = React.useCallback(() => {
    if (gitReconcileTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(gitReconcileTimeoutRef.current);
    gitReconcileTimeoutRef.current = null;
  }, []);

  const scheduleGitReconcile = React.useCallback((directory: string) => {
    clearScheduledGitReconcile();
    gitReconcileTimeoutRef.current = window.setTimeout(() => {
      gitReconcileTimeoutRef.current = null;
      if (normalizePath(directory) !== normalizePath(gitDirectory)) {
        return;
      }
      void fetchStatus(directory, git, { silent: true });
    }, GIT_RECONCILE_DELAY_MS);
  }, [clearScheduledGitReconcile, gitDirectory, fetchStatus, git]);

  React.useEffect(() => clearScheduledGitReconcile, [clearScheduledGitReconcile]);

  const clearScheduledGitMutationFlush = React.useCallback(() => {
    if (gitMutationFlushTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(gitMutationFlushTimeoutRef.current);
    gitMutationFlushTimeoutRef.current = null;
  }, []);

  const scheduleGitMutationFlush = React.useCallback(() => {
    if (gitMutationFlushTimeoutRef.current !== null) {
      return;
    }

    gitMutationFlushTimeoutRef.current = window.setTimeout(() => {
      gitMutationFlushTimeoutRef.current = null;
      flushQueuedGitMutationsRef.current?.();
    }, 0);
  }, []);

  const runGitIndexMutation = React.useCallback(async (
    directory: string,
    direction: GitIndexMutationDirection,
    paths: string[]
  ) => {
    if (direction === 'stage') {
      if (git.stageGitFiles) {
        await git.stageGitFiles(directory, paths);
        return;
      }
      await Promise.all(paths.map((filePath) => git.stageGitFile(directory, filePath)));
      return;
    }

    if (git.unstageGitFiles) {
      await git.unstageGitFiles(directory, paths);
      return;
    }
    await Promise.all(paths.map((filePath) => git.unstageGitFile(directory, filePath)));
  }, [git]);

  const gitIndexMutationQueue = React.useMemo<GitIndexMutationQueue>(() => createGitIndexMutationQueue({
    runMutation: ({ directory, direction, paths }) => runGitIndexMutation(directory, direction, paths),
    onMutationComplete: ({ directory }) => {
      bumpIndexRevision(directory);
      scheduleGitReconcile(directory);
    },
    onMutationError: ({ directory, direction, rollback }, error) => {
      rollback?.();
      bumpIndexRevision(directory);
      scheduleGitReconcile(directory);
      const fallback = direction === 'stage'
        ? t('gitView.toast.stageFileFailed')
        : t('gitView.toast.unstageFileFailed');
      toast.error(error instanceof Error ? error.message : fallback);
    },
    onPathsComplete: (paths) => {
      setMovingChangePaths((previous) => {
        const updated = new Set(previous);
        paths.forEach((path) => updated.delete(path));
        return updated;
      });
    },
    scheduleFlush: scheduleGitMutationFlush,
  }), [bumpIndexRevision, runGitIndexMutation, scheduleGitMutationFlush, scheduleGitReconcile, t]);

  React.useEffect(() => {
    flushQueuedGitMutationsRef.current = gitIndexMutationQueue.flush;
    return () => {
      flushQueuedGitMutationsRef.current = null;
    };
  }, [gitIndexMutationQueue]);

  React.useEffect(() => () => gitIndexMutationQueue.clear(), [gitIndexMutationQueue]);

  React.useEffect(() => clearScheduledGitMutationFlush, [clearScheduledGitMutationFlush]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) {
      setWorktreeBootstrapSnapshot(null);
      return;
    }

    const bootstrapDirectory = normalizePath(currentDirectory) ?? currentDirectory;
    setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: null });

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const next = await getGitWorktreeBootstrapStatus(currentDirectory);
        if (cancelled) {
          return;
        }
        setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: next.status });
        if (next.status === 'pending') {
          timeoutId = window.setTimeout(() => {
            void poll();
          }, 500);
        }
      } catch {
        if (!cancelled) {
          setWorktreeBootstrapSnapshot({ directory: bootstrapDirectory, status: null });
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isActive, currentDirectory]);

  const normalizedDraftBootstrapPendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
  const isDraftBootstrapPendingForCurrentDirectory = Boolean(
    currentDirectory && normalizedDraftBootstrapPendingDirectory && normalizedDraftBootstrapPendingDirectory === normalizePath(currentDirectory)
  );
  const sharedWorktreeBootstrapPending = useWorktreeBootstrapPending(currentDirectory ?? null);
  const normalizedCurrentBootstrapDirectory = normalizePath(currentDirectory);
  const observedWorktreeBootstrapStatus = worktreeBootstrapSnapshot?.directory === normalizedCurrentBootstrapDirectory
    ? worktreeBootstrapSnapshot.status
    : null;
  const isPendingWorktreeSetup = Boolean(
    currentDirectory
      && (
        sharedWorktreeBootstrapPending
        || observedWorktreeBootstrapStatus === 'pending'
        || (isDraftBootstrapPendingForCurrentDirectory && newSessionDraft?.pendingWorktreeRequestId)
      )
  );
  const isPostBootstrapRefreshForCurrentDirectory = Boolean(
    normalizedCurrentBootstrapDirectory
      && postBootstrapRefresh?.directory === normalizedCurrentBootstrapDirectory
  );

  React.useEffect(() => {
    if (!normalizedCurrentBootstrapDirectory) return;

    if (observedWorktreeBootstrapStatus === 'failed') {
      setDraftBootstrapPendingDirectory(null);
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory ? null : current
      ));
      return;
    }

    if (isPendingWorktreeSetup) {
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory && current.status === 'refreshing'
          ? current
          : { directory: normalizedCurrentBootstrapDirectory, status: 'refreshing' }
      ));
      return;
    }

    if (
      postBootstrapRefresh?.directory !== normalizedCurrentBootstrapDirectory
      || postBootstrapRefresh.status !== 'refreshing'
      || !gitDirectory
      || !git
    ) {
      return;
    }

    let cancelled = false;
    void fetchStatus(gitDirectory, git, {
      force: true,
      silent: true,
      throwOnError: true,
    }).then(() => {
      if (cancelled) return;
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory ? null : current
      ));
    }).catch(() => {
      if (cancelled) return;
      setPostBootstrapRefresh((current) => (
        current?.directory === normalizedCurrentBootstrapDirectory
          ? { ...current, status: 'failed' }
          : current
      ));
    });

    return () => {
      cancelled = true;
    };
  }, [fetchStatus, git, gitDirectory, isPendingWorktreeSetup, normalizedCurrentBootstrapDirectory, observedWorktreeBootstrapStatus, postBootstrapRefresh, setDraftBootstrapPendingDirectory]);

  const shouldHideGitState = isPendingWorktreeSetup || isPostBootstrapRefreshForCurrentDirectory;
  const postBootstrapRefreshFailed = isPostBootstrapRefreshForCurrentDirectory
    && postBootstrapRefresh?.status === 'failed';

  const initialSnapshot = React.useMemo(() => {
    if (!gitDirectory) return null;
    return gitViewSnapshots.get(gitDirectory) ?? null;
  }, [gitDirectory]);

  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);
  const { gitmojis: gitmojiEmojis } = useGitmojiList(settingsGitmojiEnabled);

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

  const [commitMessage, setCommitMessage] = React.useState(
    initialSnapshot?.commitMessage ?? ''
  );
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [isGitmojiPickerOpen, setIsGitmojiPickerOpen] = React.useState(false);
  const actionPanelScrollRef = React.useRef<HTMLElement | null>(null);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [isStashesDialogOpen, setIsStashesDialogOpen] = React.useState(false);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [logMaxCountLocal, setLogMaxCountLocal] = React.useState<number>(25);
  const [isSettingIdentity, setIsSettingIdentity] = React.useState(false);
  const commitCelebration = useCommitCelebration();

  const autoAppliedDefaultRef = React.useRef<Map<string, string>>(new Map());
  const identityApplyCountRef = React.useRef(0);

  const beginIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current += 1;
    if (mountedRef.current) {
      setIsSettingIdentity(true);
    }
  }, []);

  const endIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current = Math.max(0, identityApplyCountRef.current - 1);
    if (mountedRef.current && identityApplyCountRef.current === 0) {
      setIsSettingIdentity(false);
    }
  }, []);

  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [movingChangePaths, setMovingChangePaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [integrateRefreshKey, setIntegrateRefreshKey] = React.useState(0);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>(
    initialSnapshot?.generatedHighlights ?? []
  );
  const hasPendingIndexMutation = movingChangePaths.size > 0 || gitIndexMutationQueue.size() > 0 || gitIndexMutationQueue.isRunning();

  const scrollActionPanelToBottom = React.useCallback(() => {
    const scrollTarget = actionPanelScrollRef.current;
    if (!scrollTarget) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
      });
    });
  }, []);

  const repoRootForIntegrate = authoritativeProjectRoot || worktreeMetadata?.projectDirectory || null;
  const sourceBranchForIntegrate = status?.current || null;
  const shouldShowIntegrateCommits = React.useMemo(() => {
    const tracking = status?.tracking;
    if (!tracking) return true;
    return tracking.startsWith('origin/');
  }, [status?.tracking]);
  const defaultTargetBranch = React.useMemo(() => {
    const fromMeta = worktreeMetadata?.createdFromBranch;
    const normalizedFromMeta = typeof fromMeta === 'string' ? fromMeta.trim() : '';
    const current = typeof status?.current === 'string' ? status.current.trim() : '';
    const normalizedRoot = typeof rootBranchHint === 'string' ? rootBranchHint.trim() : '';

    if (normalizedFromMeta) {
      const looksLikeCorruptedSelfTarget =
        normalizedFromMeta === current &&
        normalizedFromMeta.startsWith('opencode/') &&
        normalizedRoot.length > 0 &&
        normalizedRoot !== normalizedFromMeta;

      if (looksLikeCorruptedSelfTarget) {
        return normalizedRoot;
      }

      return normalizedFromMeta;
    }
    if (normalizedRoot) {
      return normalizedRoot;
    }
    if (current) {
      return current;
    }
    return 'HEAD';
  }, [worktreeMetadata?.createdFromBranch, status, rootBranchHint]);
  const clearGeneratedHighlights = React.useCallback(() => {
    setGeneratedHighlights([]);
  }, []);
  const [expandedCommitHashes, setExpandedCommitHashes] = React.useState<Set<string>>(new Set());
  const [commitFilesMap, setCommitFilesMap] = React.useState<Map<string, CommitFileEntry[]>>(new Map());
  const [loadingCommitHashes, setLoadingCommitHashes] = React.useState<Set<string>>(new Set());
  const commitFilesMapRef = React.useRef(commitFilesMap);
  const loadingCommitHashesRef = React.useRef(loadingCommitHashes);
  const [historyBranchDivider, setHistoryBranchDivider] = React.useState<HistoryBranchDivider>(null);
  const [gitmojiSearch, setGitmojiSearch] = React.useState('');
  const [gitLogDialogMode, setGitLogDialogMode] = React.useState<GitLogDialogMode | null>(null);

  const [isUpdateBranchDialogOpen, setIsUpdateBranchDialogOpen] = React.useState(false);
  const [isIntegrateCommitsDialogOpen, setIsIntegrateCommitsDialogOpen] = React.useState(false);
  const [removingRemoteName, setRemovingRemoteName] = React.useState<string | null>(null);
  const [branchOperation, setBranchOperation] = React.useState<BranchOperation>(null);
  const [operationLogs, setOperationLogs] = React.useState<OperationLogEntry[]>([]);
  const [conflictDialogOpen, setConflictDialogOpen] = React.useState(false);
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([]);
  const [conflictOperation, setConflictOperation] = React.useState<'merge' | 'rebase'>('merge');
  const [graphLog, setGraphLog] = React.useState<import('@/lib/api/types').GitLogResponse | null>(null);
  const [graphLogLoading, setGraphLogLoading] = React.useState(false);
  const [graphLogMaxCount, setGraphLogMaxCount] = React.useState(100);
  const [graphLogRefreshToken, setGraphLogRefreshToken] = React.useState(0);

  const conflictStorageKey = React.useMemo(() => {
    if (!currentSessionId) return null;
    return `openchamber.conflict:${currentSessionId}`;
  }, [currentSessionId]);

  const persistConflictState = React.useCallback((
    directory: string,
    files: string[],
    operation: 'merge' | 'rebase'
  ) => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    const payload = { directory, conflictFiles: files, operation };
    window.localStorage.setItem(conflictStorageKey, JSON.stringify(payload));
  }, [conflictStorageKey]);

  const clearConflictState = React.useCallback(() => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    window.localStorage.removeItem(conflictStorageKey);
  }, [conflictStorageKey]);

  const openConflictDialog = React.useCallback((files: string[], operation: 'merge' | 'rebase') => {
    setConflictFiles(files);
    setConflictOperation(operation);
    setConflictDialogOpen(true);
    if (gitDirectory) {
      persistConflictState(gitDirectory, files, operation);
    }
  }, [gitDirectory, persistConflictState]);

  React.useEffect(() => {
    if (!conflictStorageKey || typeof window === 'undefined' || !gitDirectory) return;

    const raw = window.localStorage.getItem(conflictStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        directory: string;
        conflictFiles: string[];
        operation: 'merge' | 'rebase';
      };

      if (parsed.directory !== gitDirectory) {
        window.localStorage.removeItem(conflictStorageKey);
        return;
      }

      setConflictFiles(parsed.conflictFiles ?? []);
      setConflictOperation(parsed.operation ?? 'merge');
      setConflictDialogOpen(true);
    } catch {
      window.localStorage.removeItem(conflictStorageKey);
    }
  }, [conflictStorageKey, gitDirectory]);
  const [stashDialogOpen, setStashDialogOpen] = React.useState(false);
  const [pendingDirtySwitchBranch, setPendingDirtySwitchBranch] = React.useState<string | null>(null);
  const [stashDialogOperation, setStashDialogOperation] = React.useState<'merge' | 'rebase'>('merge');
  const [stashDialogBranch, setStashDialogBranch] = React.useState('');
  const [stashDialogBranchLabel, setStashDialogBranchLabel] = React.useState('');

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success(t('gitView.toast.commitHashCopied'));
        return;
      }
      toast.error(t('gitView.toast.copyFailed'));
    });
  }, [t]);

  const handleToggleCommit = React.useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    commitFilesMapRef.current = commitFilesMap;
  }, [commitFilesMap]);

  React.useEffect(() => {
    loadingCommitHashesRef.current = loadingCommitHashes;
  }, [loadingCommitHashes]);

  React.useEffect(() => {
    if (!gitDirectory || !git) return;

    const hashesToLoad = Array.from(expandedCommitHashes).filter(
      (hash) => !commitFilesMapRef.current.has(hash) && !loadingCommitHashesRef.current.has(hash)
    );

    if (hashesToLoad.length === 0) return;

    let cancelled = false;

    setLoadingCommitHashes((prev) => {
      const next = new Set(prev);
      for (const hash of hashesToLoad) {
        next.add(hash);
      }
      loadingCommitHashesRef.current = next;
      return next;
    });

    void Promise.all(
      hashesToLoad.map((hash) =>
        (git.getCommitFiles ? git.getCommitFiles(gitDirectory, hash) : Promise.resolve({ files: [] }))
          .then((response) => ({ hash, files: response.files }))
          .catch((error) => {
            console.error('Failed to fetch commit files:', error);
            return { hash, files: [] as CommitFileEntry[] };
          })
      )
    ).then((results) => {
      if (cancelled) return;
      setCommitFilesMap((prev) => {
        const next = new Map(prev);
        for (const { hash, files } of results) {
          next.set(hash, files);
        }
        commitFilesMapRef.current = next;
        return next;
      });
      setLoadingCommitHashes((prev) => {
        const next = new Set(prev);
        for (const { hash } of results) {
          next.delete(hash);
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    });

    return () => {
      cancelled = true;
      setLoadingCommitHashes((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const hash of hashesToLoad) {
          if (next.delete(hash)) {
            changed = true;
          }
        }
        if (!changed) {
          return prev;
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    };
  }, [expandedCommitHashes, gitDirectory, git]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    const snapshot = gitViewSnapshots.get(gitDirectory) ?? null;
    setCommitMessage(snapshot?.commitMessage ?? '');
    setGeneratedHighlights(snapshot?.generatedHighlights ?? []);
  }, [gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    rememberSnapshot(gitDirectory, {
      directory: gitDirectory,
      commitMessage,
      generatedHighlights,
    });
  }, [commitMessage, gitDirectory, generatedHighlights]);

  React.useEffect(() => {
    if (!isActive) return;
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [isActive, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  const refreshRemotes = React.useCallback(async () => {
    if (!gitDirectory || !git?.getRemotes || isGitRepo !== true) {
      setRemotes([]);
      return;
    }
    try {
      const remoteList = await git.getRemotes(gitDirectory);
      if (mountedRef.current) {
        setRemotes(remoteList);
      }
    } catch {
      if (mountedRef.current) {
        setRemotes([]);
      }
    }
  }, [gitDirectory, git, isGitRepo]);

  React.useEffect(() => {
    if (!isActive) return;
    void refreshRemotes();
  }, [isActive, refreshRemotes]);

  React.useEffect(() => {
    if (!isActive) return;
    if (currentDirectory && gitDirectory) {
      setActiveDirectory(currentDirectory);
      void ensureAll(gitDirectory, git);
    }
  }, [isActive, currentDirectory, gitDirectory, setActiveDirectory, ensureAll, git]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!gitDirectory) {
      return;
    }

    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(gitDirectory)) {
        return;
      }
      if (hint.paths?.length) {
        clearDiffCache(gitDirectory, hint.paths);
      }
      void fetchStatus(gitDirectory, git, { silent: true });
    });
  }, [isActive, clearDiffCache, gitDirectory, fetchStatus, git]);

  const refreshStatusAndBranches = React.useCallback(
    async (showErrors = true) => {
      if (!gitDirectory) return;

      try {
        await Promise.all([
          fetchStatus(gitDirectory, git),
          fetchBranches(gitDirectory, git),
        ]);
      } catch (err) {
        if (showErrors) {
          const message =
            err instanceof Error ? err.message : t('gitView.toast.refreshRepositoryFailed');
          toast.error(message);
        }
      }
    },
    [gitDirectory, git, fetchStatus, fetchBranches, t]
  );

  const refreshLog = React.useCallback(async () => {
    if (!gitDirectory) return;
    await fetchLog(gitDirectory, git, logMaxCountLocal);
  }, [gitDirectory, git, fetchLog, logMaxCountLocal]);

  const refreshAfterGitAction = React.useCallback(async (onBackgroundSettled?: () => void) => {
    if (!gitDirectory) return;
    const background = Promise.allSettled([fetchBranches(gitDirectory, git), refreshLog()]);
    if (onBackgroundSettled) void background.then(onBackgroundSettled);
    await fetchStatus(gitDirectory, git).catch(() => undefined);
  }, [gitDirectory, git, fetchBranches, fetchStatus, refreshLog]);

  const refreshIdentity = React.useCallback(async () => {
    if (!gitDirectory) return;
    await fetchIdentity(gitDirectory, git);
  }, [gitDirectory, git, fetchIdentity]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!gitDirectory) return;
    if (!git?.hasLocalIdentity) return;
    if (isGitRepo !== true) return;

    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (!defaultId || defaultId === 'global') return;

    const runtimeKey = getRuntimeKey();
    const attemptKey = JSON.stringify([runtimeKey, gitDirectory]);
    const previousAttempt = autoAppliedDefaultRef.current.get(attemptKey);
    if (previousAttempt === defaultId) return;

    let cancelled = false;
    let started = false;

    const run = async () => {
      try {
        const hasLocal = await git.hasLocalIdentity?.(gitDirectory);
        if (cancelled || getRuntimeKey() !== runtimeKey) return;
        if (hasLocal === true) return;

        if (git.setGitIdentity) {
          beginIdentityApply();
          started = true;
          await git.setGitIdentity(gitDirectory, defaultId);
          if (cancelled || getRuntimeKey() !== runtimeKey) return;
          autoAppliedDefaultRef.current.set(attemptKey, defaultId);
        }
        await refreshIdentity();
      } catch (error) {
        if (!cancelled && getRuntimeKey() === runtimeKey) {
          console.warn('Failed to auto-apply default git identity:', error);
        }
      } finally {
        if (started) endIdentityApply();
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isActive, beginIdentityApply, gitDirectory, defaultGitIdentityId, endIdentityApply, git, isGitRepo, refreshIdentity]);

  const changeEntries = React.useMemo(() => {
    if (!status) return [];
    const files = status.files ?? [];
    return [...files].sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries]
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries]
  );

  React.useEffect(() => {
    if (!isActive || !gitDirectory || changeEntries.length === 0) {
      return;
    }

    const orderedPaths: string[] = [];
    const seen = new Set<string>();

    const pushPath = (path: string) => {
      if (!path || seen.has(path)) {
        return;
      }
      seen.add(path);
      orderedPaths.push(path);
    };

    stagedChangeEntries.forEach((entry) => pushPath(entry.path));
    visibleChangePaths.forEach(pushPath);
    changeEntries.slice(0, GIT_DIFF_PRIORITY_BASELINE_LIMIT).forEach((entry) => pushPath(entry.path));

    if (orderedPaths.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(gitDirectory, git, orderedPaths, { maxFiles: GIT_DIFF_PRIORITY_PREFETCH_LIMIT });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isActive, changeEntries, gitDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote, forceChoose = false) => {
    if (!gitDirectory) return;
    const recovery = operationRecovery.start();
    if (!recovery) return;
    setSyncAction(action);
    const actionLabel = t(action === 'fetch' ? 'gitView.sync.fetch' : action === 'pull' ? 'gitView.sync.pull' : action === 'publish' ? 'gitView.publish.title' : 'gitView.sync.syncChanges');
    let syncOutcome: GitSyncOutcome | null = null;

    try {
      if (action === 'sync' || action === 'publish') {
        const execute = await publishChooser.prepare(action === 'publish' ? 'push' : 'sync', { forceChoose, onOperation: recovery.onOperation });
        syncOutcome = describeGitSyncOutcome(await execute());
      } else if (remote && status) {
        await runBoundGitNetworkOperation({
          action, directory: gitDirectory, remoteName: remote.name, status, sourceControl, git, onOperation: recovery.onOperation,
        });
      } else {
        throw new BoundGitNetworkOperationError('tracking-required');
      }

      if (!recovery.isCurrent()) return;
      if (action === 'fetch' && remote) {
        toast.success(t('gitView.toast.fetchedFromRemote', { name: remote.name }));
      } else if (action === 'pull' && remote) {
        toast.success(t('gitView.toast.pulledFromRemote', { name: remote.name }));
      } else if (action === 'sync') {
        toast.success(syncOutcome?.kind === 'up-to-date'
          ? t('gitView.toast.alreadyUpToDate')
          : syncOutcome?.kind === 'pulled'
            ? t('gitView.toast.pulledFromRemote', { name: syncOutcome.remoteName })
            : syncOutcome?.kind === 'pushed'
              ? t('gitView.toast.pushedToUpstream', { name: syncOutcome.remoteName })
              : t('gitView.toast.syncedChanges'));
      } else if (action === 'publish') {
        toast.success(t('gitView.publish.succeeded'));
      }

      await refreshAfterGitAction();
    } catch (err) {
      if (err instanceof GitOperationResultError || err instanceof PendingGitOperationError) {
        if (err instanceof GitOperationResultError && err.read.availability === 'available') {
          toast.error(t('gitView.toast.syncActionFailed', { action: actionLabel }), { description: err.message || undefined });
        }
        if (recovery.isCurrent()) await refreshAfterGitAction();
        if (recovery.isCurrent() && err instanceof GitOperationResultError && err.read.availability === 'available'
          && err.read.operation.state === 'conflicted' && err.read.operation.error.code === 'CONFLICT') {
          const afterConflict = await git.getGitStatus(gitDirectory).catch(() => null);
          const files = (afterConflict?.files ?? []).filter(isConflictedStatusFile).map((file) => file.path);
          if (files.length > 0) openConflictDialog(files, 'merge');
        }
        return;
      }
      if (err instanceof BoundGitNetworkOperationError && err.code === 'stale-runtime') return;
      if (err instanceof BoundGitNetworkOperationError && publishChooser.errorMessage(err)) {
        toast.info(publishChooser.errorMessage(err));
        return;
      }
      await refreshAfterGitAction();
      const message =
        err instanceof BoundGitNetworkOperationError
          ? err.code === 'contributor-publish-cancelled-after-update'
            ? t('gitView.toast.contributorPublishCancelledAfterUpdate')
            : err.code === 'contributor-publish-cancelled'
              ? t('gitView.toast.contributorPublishCancelled')
              : t('gitView.toast.syncActionFailed', { action: actionLabel })
          : err instanceof Error
          ? gitRequestErrorMessage(err, t)
          : t('gitView.toast.syncActionFailed', { action: actionLabel });
      toast.error(message);
    } finally {
      recovery.finish();
      if (recovery.isCurrent()) setSyncAction(null);
    }
  };

  const handleRemoveRemote = React.useCallback(async (remote: GitRemote) => {
    if (!gitDirectory) return;

    const remoteName = remote.name.trim();
    if (!remoteName) {
      toast.error(t('gitView.toast.remoteNameRequired'));
      return;
    }
    if (remoteName === 'origin') {
      toast.error(t('gitView.toast.cannotRemoveOriginRemote'));
      return;
    }

    setRemovingRemoteName(remoteName);
    try {
      await git.removeRemote(gitDirectory, { remote: remoteName });
      toast.success(t('gitView.toast.removedRemote', { name: remoteName }));
      await Promise.all([
        refreshStatusAndBranches(false),
        refreshRemotes(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to remove ${remoteName}`;
      toast.error(message);
    } finally {
      setRemovingRemoteName(null);
    }
  }, [gitDirectory, git, refreshRemotes, refreshStatusAndBranches, t]);

  const handleCommit = async (options: { pushAfter?: boolean; origin?: HTMLElement } = {}) => {
    if (!gitDirectory) return;
    if (!commitMessage.trim()) {
      toast.error(t('gitView.toast.enterCommitMessage'));
      return;
    }

    const filesToCommit = stagedChangeEntries.map((file) => file.path).sort();
    if (filesToCommit.length === 0) {
      toast.error(t('gitView.toast.stageFileToCommit'));
      return;
    }

    const action: CommitAction = options.pushAfter ? 'commitAndPush' : 'commit';
    setCommitAction(action);
    let recovery: ReturnType<typeof operationRecovery.start> = null;
    let commitOutcome: 'pending' | 'local' | 'published' = 'pending';

    try {
      if (!git.createGitCommit) throw new Error('Git commit is unavailable on this runtime');
      const commit = await git.createGitCommit(gitDirectory, commitMessage.trim(), {
        files: filesToCommit,
        stageFiles: [],
      });
      commitOutcome = 'local';
      bumpIndexRevision(gitDirectory);
      bumpIndexRevision(gitDirectory);
      const deletion = commitCelebration.committed(commit.summary, options);
      setCommitMessage('');
      clearGeneratedHighlights();

      if (options.pushAfter) {
        recovery = operationRecovery.start();
        if (!recovery) {
          toast.warning(t('gitView.publish.commitKept'));
          await refreshAfterGitAction();
          return;
        }
        const executePush = await publishChooser.prepare('push', { onOperation: recovery.onOperation });
        setSyncAction('publish');
        await executePush();
        commitOutcome = 'published';
        commitCelebration.pushed({ deletion, origin: options.origin });
      }
      await refreshAfterGitAction(() => setIntegrateRefreshKey((v) => v + 1));
    } catch (err) {
      if (options.pushAfter && commitOutcome === 'local') toast.warning(t('gitView.publish.commitKept'));
      if (err instanceof GitOperationResultError || err instanceof PendingGitOperationError) {
        if (err instanceof GitOperationResultError && err.read.availability === 'available') {
          toast.error(t('gitView.toast.pushFailed'), { description: err.message || undefined });
        }
        await refreshAfterGitAction();
        return;
      }
      if (err instanceof BoundGitNetworkOperationError && err.code === 'stale-runtime') return;
      if (err instanceof BoundGitNetworkOperationError && publishChooser.errorMessage(err)) {
        toast.info(publishChooser.errorMessage(err));
        return;
      }
      if (options.pushAfter) await refreshAfterGitAction();
      const message = err instanceof BoundGitNetworkOperationError
        ? err.code === 'contributor-publish-cancelled-after-update'
          ? t('gitView.toast.contributorPublishCancelledAfterUpdate')
          : err.code === 'contributor-publish-cancelled'
            ? t('gitView.toast.contributorPublishCancelled')
            : t('gitView.toast.syncActionFailed', { action: t('gitView.sync.syncChanges') })
        : err instanceof Error ? gitRequestErrorMessage(err, t) : t('gitView.toast.createCommitFailed');
      toast.error(message);
    } finally {
      recovery?.finish();
      setCommitAction(null);
      if (options.pushAfter) setSyncAction(null);
    }
  };

  const handleGenerateCommitMessage = React.useCallback(async () => {
    if (!gitDirectory) return;
    const selectedFilePaths = stagedChangeEntries.map((file) => file.path).sort();
    if (selectedFilePaths.length === 0) {
      toast.error(t('gitView.toast.stageFileToDescribe'));
      return;
    }

    console.error('[git-generation][browser] generate button clicked', {
      directory: gitDirectory,
      selectedFiles: selectedFilePaths.length,
    });

    setIsGeneratingMessage(true);
    try {
      const { message } = await generateSessionCommitMessage(gitDirectory, selectedFilePaths);
      const subject = message.subject?.trim() ?? '';
      const highlights = Array.isArray(message.highlights) ? message.highlights : [];

      if (subject) {
        let finalSubject = subject;
        if (settingsGitmojiEnabled && gitmojiEmojis.length > 0) {
          const match = matchGitmojiFromSubject(subject, gitmojiEmojis);
          if (match) {
            const { code, emoji } = match;
            if (!subject.startsWith(code) && !subject.startsWith(emoji)) {
              finalSubject = `${code} ${subject}`;
            }
          }
        }
        setCommitMessage(finalSubject);
      }
      setGeneratedHighlights(highlights);

      scrollActionPanelToBottom();
    } catch (error) {
      console.error('[git-generation][browser] GitView generate handler failed', {
        message: error instanceof Error ? error.message : String(error),
        error,
      });
      const message =
        error instanceof Error ? error.message : t('gitView.toast.generateCommitMessageFailed');
      toast.error(message);
    } finally {
      setIsGeneratingMessage(false);
    }
  }, [gitDirectory, stagedChangeEntries, settingsGitmojiEnabled, gitmojiEmojis, scrollActionPanelToBottom, t]);

  const formatBlockingReason = (reason: ReturnType<typeof getMutationBlockingReasons>[number]): string => {
    if (reason.reason === 'attention') {
      return `${reason.attentionReason} in progress`;
    }
    if (reason.reason === 'missing') {
      return 'worktree is missing';
    }
    return 'worktree is invalid';
  };

  const handleCreateBranch = async (branchName: string) => {
    if (!gitDirectory || !status) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotCreateBranch', { reason: formatBlockingReason(blockingReasons[0]) }));
      return;
    }

    const checkoutBase = status.current ?? null;

    try {
      await git.createBranch(gitDirectory, branchName, checkoutBase ?? 'HEAD');
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));

      if (!git.checkoutBranch) throw new Error('Branch checkout is unavailable on this runtime');
      await git.checkoutBranch(gitDirectory, branchName);

      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      if (err instanceof BoundGitNetworkOperationError && err.code === 'stale-runtime') return;
      const message = err instanceof Error ? err.message : t('gitView.toast.createBranchFailed');
      toast.error(message);
      throw err;
    }
  };

  const handleRenameBranch = async (oldName: string, newName: string) => {
    if (!gitDirectory) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotRenameBranch', { reason: formatBlockingReason(blockingReasons[0]) }));
      return;
    }

    try {
      await git.renameBranch(gitDirectory, oldName, newName);
      toast.success(t('gitView.toast.renamedBranch', { oldName, newName }));
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('gitView.toast.renameBranchFailed', { oldName, newName });
      toast.error(message);
    }
  };

  const handleCheckoutBranch = async (branch: string) => {
    if (!gitDirectory) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotCheckout', { reason: formatBlockingReason(blockingReasons[0]) }));
      return;
    }

    const normalized = branch.replace(/^remotes\//, '');

    if (status?.current === normalized) {
      return;
    }

    if ((status?.files?.length ?? 0) > 0) {
      setPendingDirtySwitchBranch(normalized);
      return;
    }

    await performCheckout(normalized);
  };

  const performCheckout = async (branch: string) => {
    if (!gitDirectory) return;
    const normalized = branch;
    try {
      if (!git.checkoutBranch) throw new Error('Branch checkout is unavailable on this runtime');
      const result = await git.checkoutBranch(gitDirectory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: result?.branch || normalized }));
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('gitView.toast.checkoutFailed', { name: normalized });
      toast.error(message);
    }
  };

  const handleApplyIdentity = async (profile: GitIdentityProfile) => {
    if (!gitDirectory) return;
    const runtimeKey = getRuntimeKey();
    beginIdentityApply();

    try {
      const outcome = await applyIdentityToRepository(
        { directory: gitDirectory, identity: profile, remoteName: bindingRemoteName || null },
        { git, sourceControl },
      );
      if (getRuntimeKey() !== runtimeKey) return;
      if (outcome.status === 'failed') toast.error(t('gitView.toast.applyIdentityFailed'));
      else toast.success(t('gitView.toast.appliedIdentity', { name: identityDisplayName(profile, t) }));
      await refreshIdentity();
    } catch (err) {
      if (getRuntimeKey() !== runtimeKey) return;
      const message = err instanceof Error ? err.message : t('gitView.toast.applyIdentityFailed');
      toast.error(message);
    } finally {
      endIdentityApply();
    }
  };

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


  const branchIntegrationRemoteBranches = React.useMemo<BranchIntegrationRemoteBranch[]>(() => {
    return createRemoteBranchIntegrationTargets(remotes.map((remote) => remote.name), remoteBranches);
  }, [remotes, remoteBranches]);

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
    localBranches,
    binding.read,
    rootBranchHint,
    worktreeMetadata?.createdFromBranch,
  ]);
  const baseBranch = useBranchPullRequestBase(gitDirectory ?? null, currentBranch, isActive, binding, branches, derivedBaseBranch);
  useBranchPullRequestRequest(isActive ? gitDirectory ?? null : null, isActive ? currentBranch : null, binding);

  const updateTargetBranch = React.useMemo(() => {
    const primaryRemote = binding.contexts[0]?.primaryRemote;
    const remoteCandidate = primaryRemote ? `${primaryRemote}/${baseBranch}` : null;
    return remoteCandidate && remoteBranches.includes(remoteCandidate) ? remoteCandidate : baseBranch;
  }, [baseBranch, binding.contexts, remoteBranches]);

  const connectedAccountIds = useConnectedAccountIds();
  const availableIdentities = React.useMemo(
    () => offeredAuthors(profiles, globalIdentity, connectedAccountIds),
    [profiles, globalIdentity, connectedAccountIds],
  );

  const boundAccountId = binding.read
    ? binding.read.binding?.providers.find((provider) => provider.readiness === 'ready')?.accountId ?? null
    : undefined;
  const activeIdentityProfile = React.useMemo(
    () => activeAuthor(profiles, globalIdentity, currentIdentity, boundAccountId),
    [boundAccountId, currentIdentity, profiles, globalIdentity],
  );

  const stagedCount = stagedChangeEntries.length;
  const isBusy = isLoading || syncAction !== null || commitAction !== null;
  const canShowIntegrateCommitsSection = Boolean(
    worktreeMetadata && repoRootForIntegrate && sourceBranchForIntegrate && shouldShowIntegrateCommits
  );
  const canShowBranchWorkflows = Boolean(currentBranch);
  const integrateCommitsProps =
    canShowIntegrateCommitsSection && repoRootForIntegrate && sourceBranchForIntegrate && worktreeMetadata
      ? {
          repoRoot: repoRootForIntegrate,
          sourceBranch: sourceBranchForIntegrate,
          worktreeMetadata,
        }
      : null;

  React.useEffect(() => {
    if (!gitDirectory || !git || !log?.all?.length || !currentBranch || !baseBranch || currentBranch === baseBranch) {
      setHistoryBranchDivider(null);
      return;
    }

    let cancelled = false;

    const resolveBranchDivider = async () => {
      try {
        if (!git.getGitLog) return;
        const branchOnlyLog = await git.getGitLog(gitDirectory, {
          from: baseBranch,
          to: 'HEAD',
          maxCount: logMaxCountLocal,
        });

        if (cancelled) {
          return;
        }

        const branchHashes = new Set(
          (branchOnlyLog?.all ?? [])
            .map((entry) => entry.hash)
            .filter((hash) => typeof hash === 'string' && hash.length > 0)
        );

        if (branchHashes.size === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        const insertBeforeIndex = log.all.findIndex((entry) => !branchHashes.has(entry.hash));
        if (insertBeforeIndex === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        if (insertBeforeIndex === -1) {
          setHistoryBranchDivider({
            insertBeforeIndex: log.all.length,
            branchName: currentBranch,
            direction: 'up',
          });
          return;
        }

        setHistoryBranchDivider({
          insertBeforeIndex,
          branchName: currentBranch,
          direction: 'up',
        });
      } catch {
        if (!cancelled) {
          setHistoryBranchDivider(null);
        }
      }
    };

    void resolveBranchDivider();

    return () => {
      cancelled = true;
    };
  }, [baseBranch, currentBranch, gitDirectory, git, log, logMaxCountLocal]);

  React.useEffect(() => {
    setGraphLog(null);
  }, [gitDirectory]);

  React.useEffect(() => {
    if (gitLogDialogMode !== 'graph' || !gitDirectory) {
      if (gitLogDialogMode !== 'graph') setGraphLog(null);
      return;
    }
    let cancelled = false;
    setGraphLogLoading(true);
    if (!git.getGitLog) {
      setGraphLogLoading(false);
      return;
    }
    git.getGitLog(gitDirectory, { maxCount: graphLogMaxCount, all: true })
      .then((result) => {
        if (!cancelled) setGraphLog(result);
      })
      .catch((err) => {
        console.error('Failed to fetch graph log:', err);
      })
      .finally(() => {
        if (!cancelled) setGraphLogLoading(false);
      });
    return () => { cancelled = true; };
  }, [gitLogDialogMode, gitDirectory, graphLogMaxCount, graphLogRefreshToken, git]);


  const moveChangePaths = React.useCallback((paths: string[], direction: GitIndexMutationDirection) => {
    if (!gitDirectory || paths.length === 0) return;
    const uniquePaths = Array.from(new Set(paths));
    setMovingChangePaths((previous) => {
      const next = new Set(previous);
      uniquePaths.forEach((path) => next.add(path));
      return next;
    });
    const previousStatus = moveStatusPathsOptimistically(gitDirectory, uniquePaths, direction);

    gitIndexMutationQueue.enqueue({
      directory: gitDirectory,
      direction,
      paths: new Set(uniquePaths),
      rollback: () => restoreStatus(gitDirectory, previousStatus),
    });

    scheduleGitMutationFlush();
  }, [gitDirectory, gitIndexMutationQueue, moveStatusPathsOptimistically, restoreStatus, scheduleGitMutationFlush]);

  const handleRevertFile = React.useCallback(
    async (filePath: string) => {
      if (!gitDirectory) return;

      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.revertGitFile(gitDirectory, filePath, { scope: 'working' });
        toast.success(t('gitView.toast.revertedFile', { path: filePath }));
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('gitView.toast.revertFailed');
        toast.error(message);
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [gitDirectory, refreshStatusAndBranches, git, t]
  );

  const handleRevertPaths = React.useCallback(
    async (paths: string[], setGlobalReverting: boolean, scope: 'all' | 'working' = 'all') => {
      if (!gitDirectory || paths.length === 0) {
        return;
      }

      const uniquePaths = Array.from(new Set(paths));
      if (isRevertingAll || uniquePaths.some((path) => revertingPaths.has(path))) {
        return;
      }

      const stagedPaths = new Set(stagedChangeEntries.map((entry) => entry.path));
      const touchesStagedIndex = scope === 'all' && uniquePaths.some((path) => stagedPaths.has(path));

      if (setGlobalReverting) {
        setIsRevertingAll(true);
      }
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        uniquePaths.forEach((path) => next.add(path));
        return next;
      });

      const failed: Array<{ path: string; message: string }> = [];

      try {
        await mapWithConcurrency(uniquePaths, REVERT_PATHS_CONCURRENCY, async (filePath) => {
          try {
            await git.revertGitFile(gitDirectory, filePath, { scope });
          } catch (err) {
            failed.push({
              path: filePath,
              message: err instanceof Error ? err.message : t('gitView.toast.revertFailed'),
            });
          }
        });

        if (touchesStagedIndex && failed.length < uniquePaths.length) {
          bumpIndexRevision(gitDirectory);
        }

        await refreshStatusAndBranches(false);

        if (failed.length === 0) {
          toast.success(
            uniquePaths.length === 1
              ? t('gitView.toast.revertedFilesSingle', { count: uniquePaths.length })
              : t('gitView.toast.revertedFilesPlural', { count: uniquePaths.length })
          );
        } else if (failed.length === uniquePaths.length) {
          toast.error(failed[0]?.message || t('gitView.toast.revertFailed'));
        } else {
          const successCount = uniquePaths.length - failed.length;
          toast.warning(
            successCount === 1
              ? t('gitView.toast.revertedSomeSingle', { success: successCount, failed: failed.length })
              : t('gitView.toast.revertedSomePlural', { success: successCount, failed: failed.length })
          );
        }
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          uniquePaths.forEach((path) => next.delete(path));
          return next;
        });
        if (setGlobalReverting) {
          setIsRevertingAll(false);
        }
      }
    },
    [bumpIndexRevision, gitDirectory, git, isRevertingAll, refreshStatusAndBranches, revertingPaths, stagedChangeEntries, t]
  );

  const handleRevertAll = React.useCallback(
    async (paths: string[]) => {
      await handleRevertPaths(paths, true);
    },
    [handleRevertPaths]
  );

  const handleRevertDirectory = React.useCallback(
    async (paths: string[]) => {
      await handleRevertPaths(paths, false, 'working');
    },
    [handleRevertPaths]
  );

  const handleViewChangeDiff = React.useCallback((path: string, staged: boolean) => {
    if (panelDirectory && !isMobile) {
      openContextDiff(panelDirectory, path, staged);
      return;
    }
    navigateToDiff(path, staged);
  }, [panelDirectory, isMobile, navigateToDiff, openContextDiff]);

  const openStashes = React.useCallback(() => setIsStashesDialogOpen(true), []);

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
        statsScope: 'staged',
        actionSymbol: '-',
        actionAllLabel: t('gitView.changes.unstageAllAria'),
        getActionLabel: (path) => t('gitView.changes.unstageFileAria', { path }),
        onActionFile: (path) => void moveChangePaths([path], 'unstage'),
        onActionAll: (paths) => void moveChangePaths(paths, 'unstage'),
        onViewDiff: (path) => handleViewChangeDiff(path, true),
        onRevertFile: handleRevertFile,
        showRevertActions: false,
        accent: true,
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: t('gitView.changes.title'),
        entries: unstagedChangeEntries,
        statsScope: 'working',
        actionSymbol: '+',
        actionAllLabel: t('gitView.changes.stageAllAria'),
        getActionLabel: (path) => t('gitView.changes.stageFileAria', { path }),
        onActionFile: (path) => void moveChangePaths([path], 'stage'),
        onActionAll: (paths) => void moveChangePaths(paths, 'stage'),
        onViewDiff: (path) => handleViewChangeDiff(path, false),
        onRevertFile: handleRevertFile,
      });
    }

    return groups;
  }, [
    handleRevertFile,
    handleViewChangeDiff,
    moveChangePaths,
    stagedChangeEntries,
    t,
    unstagedChangeEntries,
  ]);

  const handleInsertHighlights = React.useCallback((sourceHighlights: string[]) => {
    if (sourceHighlights.length === 0) return;
    const normalizedHighlights = sourceHighlights
      .map((text) => text.trim())
      .filter(Boolean);
    if (normalizedHighlights.length === 0) {
      clearGeneratedHighlights();
      return;
    }
    setCommitMessage((current) => {
      const base = current.trim();
      const separator = base.length > 0 ? '\n\n' : '';
      return `${base}${separator}${normalizedHighlights.join('\n')}`.trim();
    });
    clearGeneratedHighlights();
  }, [clearGeneratedHighlights]);

  const handleSelectGitmoji = React.useCallback((emoji: string, code: string) => {
    const token = code || emoji;
    setCommitMessage((current) => {
      const trimmed = current.trimStart();
      if (trimmed.startsWith(emoji) || (code && trimmed.startsWith(code))) {
        return current;
      }
      const prefix = token.endsWith(' ') ? token : `${token} `;
      return `${prefix}${current}`.trimStart();
    });
    setGitmojiSearch('');
    setIsGitmojiPickerOpen(false);
  }, []);



  const isUncommittedChangesError = React.useCallback((error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
      message.includes('uncommitted changes') ||
      message.includes('local changes') ||
      message.includes('your local changes would be overwritten') ||
      message.includes('please commit your changes or stash them') ||
      message.includes('cannot rebase: you have unstaged changes') ||
      message.includes('error: cannot pull with rebase')
    );
  }, []);

  const addOperationLog = React.useCallback((message: string, status: OperationLogEntry['status']) => {
    setOperationLogs(prev => [...prev, { message, status, timestamp: Date.now() }]);
  }, []);

  const updateLastLog = React.useCallback((status: OperationLogEntry['status'], message?: string) => {
    setOperationLogs(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        status,
        ...(message ? { message } : {}),
      };
      return updated;
    });
  }, []);

  const resetOperationLogs = React.useCallback(() => {
    setOperationLogs([]);
  }, []);

  const handleOperationComplete = React.useCallback(() => {
    setOperationLogs([]);
    setBranchOperation(null);
  }, []);

  const handleBranchIntegration = React.useCallback(
    async (operation: Exclude<BranchOperation, null>, target: BranchIntegrationTarget) => {
      if (!gitDirectory) return;
      const recovery = target.kind === 'remote' ? operationRecovery.start() : null;
      if (target.kind === 'remote' && !recovery) return;
      setBranchOperation(operation);
      resetOperationLogs();

      const currentBranch = status?.current;
      let integrationRef = target.branch;

      try {
        integrationRef = await resolveBranchIntegrationRef({
          directory: gitDirectory,
          git,
          target,
          runPlannedFetch: async (remoteTarget) => {
            addOperationLog(`Fetching ${remoteTarget.label}...`, 'running');
            if (!status || !recovery) throw new BoundGitNetworkOperationError('branch-required');
            await runBoundGitNetworkOperation({
              action: 'fetch',
              directory: gitDirectory,
              fetchTarget: {
                remoteName: remoteTarget.remote,
                sourceRef: remoteTarget.sourceRef,
                destinationRef: remoteTarget.destinationRef,
              },
              remoteName: remoteTarget.remote,
              status,
              sourceControl,
              git,
              onOperation: recovery.onOperation,
            });
            if (!recovery.isCurrent()) throw new BoundGitNetworkOperationError('stale-runtime');
            updateLastLog('done', `Fetched ${remoteTarget.label}`);
          },
        });
        if (recovery && !recovery.isCurrent()) throw new BoundGitNetworkOperationError('stale-runtime');

        if (operation === 'merge') {
          addOperationLog(`Merging ${target.label} into ${currentBranch}...`, 'running');
          if (!git.merge) throw new Error('Git merge is unavailable on this runtime');
          const result = await git.merge(gitDirectory, { branch: integrationRef });

          if (result.conflict) {
            updateLastLog('error', 'Merge conflicts detected');
            openConflictDialog(result.conflictFiles ?? [], 'merge');
          } else {
            updateLastLog('done', `Merged ${target.label} into ${currentBranch}`);
            clearConflictState();
            addOperationLog('Refreshing repository status...', 'running');
            await refreshStatusAndBranches();
            await refreshLog();
            updateLastLog('done', 'Repository status updated');
          }
        } else {
          addOperationLog(`Rebasing ${currentBranch} onto ${target.label}...`, 'running');
          if (!git.rebase) throw new Error('Git rebase is unavailable on this runtime');
          const result = await git.rebase(gitDirectory, { onto: integrationRef });

          if (result.conflict) {
            updateLastLog('error', 'Rebase conflicts detected');
            openConflictDialog(result.conflictFiles ?? [], 'rebase');
          } else {
            updateLastLog('done', `Rebased ${currentBranch} onto ${target.label}`);
            clearConflictState();
            addOperationLog('Refreshing repository status...', 'running');
            await refreshStatusAndBranches();
            await refreshLog();
            updateLastLog('done', 'Repository status updated');
          }
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation(operation);
          setStashDialogBranch(integrationRef);
          setStashDialogBranchLabel(target.label);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof BoundGitNetworkOperationError
            ? t('gitView.toast.syncActionFailed', { action: t('gitView.sync.fetch') })
            : err instanceof Error
              ? err.message
              : operation === 'merge'
                ? `Failed to merge ${target.label}`
                : `Failed to rebase onto ${target.label}`;
          updateLastLog('error', message);
        }
      } finally {
        recovery?.finish();
      }
    },
    [gitDirectory, git, sourceControl, status, operationRecovery, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, openConflictDialog, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs, t]
  );

  const handleMerge = React.useCallback(
    (target: BranchIntegrationTarget) => {
      void handleBranchIntegration('merge', target);
    },
    [handleBranchIntegration]
  );

  const handleRebase = React.useCallback(
    (target: BranchIntegrationTarget) => {
      void handleBranchIntegration('rebase', target);
    },
    [handleBranchIntegration]
  );

  const handleAbortConflict = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      if (conflictOperation === 'merge') {
        if (!git.abortMerge) throw new Error('Git abort merge is unavailable on this runtime');
        await git.abortMerge(gitDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
        if (!git.abortRebase) throw new Error('Git abort rebase is unavailable on this runtime');
        await git.abortRebase(gitDirectory);
        toast.success(t('gitView.toast.rebaseAborted'));
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to abort ${conflictOperation}`;
      toast.error(message);
    }
  }, [gitDirectory, git, conflictOperation, refreshStatusAndBranches, refreshLog, clearConflictState, t]);

  const conflictCount = React.useMemo(
    () => (status?.files ?? []).filter(isConflictedStatusFile).length,
    [status?.files]
  );

  const handleContinueOperation = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      const isRebase = !!(status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto);

      if (isMerge) {
        const result = git.continueMerge
          ? await git.continueMerge(gitDirectory)
          : null;
        if (result?.conflict) {
          openConflictDialog(result.conflictFiles ?? [], 'merge');
          toast.error(t('gitView.toast.mergeConflictsDetected'));
        } else if (result) {
          clearConflictState();
          toast.success(t('gitView.toast.mergeCompleted'));
          await refreshStatusAndBranches();
          await refreshLog();
        }
      } else if (isRebase) {
        const result = git.continueRebase
          ? await git.continueRebase(gitDirectory)
          : null;
        if (result?.conflict) {
          openConflictDialog(result.conflictFiles ?? [], 'rebase');
          toast.error(t('gitView.toast.rebaseConflictsDetected'));
        } else if (result) {
          clearConflictState();
          toast.success(t('gitView.toast.rebaseStepCompleted'));
          await refreshStatusAndBranches();
          await refreshLog();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.continueOperationFailed');
      toast.error(message);
    }
  }, [gitDirectory, git, status, refreshStatusAndBranches, refreshLog, openConflictDialog, clearConflictState, t]);

  const handleAbortOperation = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      if (isMerge) {
        if (!git.abortMerge) throw new Error('Git abort merge is unavailable on this runtime');
        await git.abortMerge(gitDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
        if (!git.abortRebase) throw new Error('Git abort rebase is unavailable on this runtime');
        await git.abortRebase(gitDirectory);
        toast.success(t('gitView.toast.rebaseAborted'));
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.abortOperationFailed');
      toast.error(message);
    }
  }, [gitDirectory, git, status, refreshStatusAndBranches, refreshLog, clearConflictState, t]);

  const handleResolveWithAIFromBanner = React.useCallback(() => {
    if (!gitDirectory) return;

    const isMerge = !!status?.mergeInProgress?.head;
    const operation = isMerge ? 'merge' : 'rebase';

    const filesWithConflicts = (status?.files ?? []).filter(isConflictedStatusFile).map((f) => f.path);

    if (filesWithConflicts.length > 0) {
      setConflictFiles(filesWithConflicts);
    }
    setConflictOperation(operation);
    setConflictDialogOpen(true);
  }, [gitDirectory, status]);

  const handleStashAndRetry = React.useCallback(
    async (restoreAfter: boolean) => {
      if (!gitDirectory) return;

      const currentBranch = status?.current;
      const operation = stashDialogOperation;
      const branch = stashDialogBranch;
      const branchLabel = stashDialogBranchLabel || branch;
      const hadStagedChanges = (status?.files ?? []).some(isStagedStatusFile);

      try {
        await git.stash(gitDirectory, {
          message: `Auto-stash before ${operation} with ${branchLabel}`,
          includeUntracked: true,
        });
        if (hadStagedChanges) {
          bumpIndexRevision(gitDirectory);
        }
      } catch (stashErr) {
        const msg = stashErr instanceof Error ? stashErr.message : 'Failed to stash changes';
        toast.error(msg);
        return;
      }

      let operationSucceeded = false;
      let hasConflict = false;

      try {
        if (operation === 'merge') {
          if (!git.merge) throw new Error('Git merge is unavailable on this runtime');
          const result = await git.merge(gitDirectory, { branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('merge');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.mergedIntoBranch', { branch: branchLabel, currentBranch: currentBranch || '' }));
          }
        } else {
          if (!git.rebase) throw new Error('Git rebase is unavailable on this runtime');
          const result = await git.rebase(gitDirectory, { onto: branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('rebase');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.rebasedOntoBranch', { currentBranch: currentBranch || '', branch: branchLabel }));
          }
        }

        if (restoreAfter && operationSucceeded) {
          try {
            await git.stashPop(gitDirectory);
            bumpIndexRevision(gitDirectory);
            toast.success(t('gitView.toast.stashedRestored'));
          } catch (popErr) {
            const popMessage = popErr instanceof Error ? popErr.message : t('gitView.toast.restoreStashFailed');
            toast.error(popMessage);
          }
        } else if (restoreAfter && hasConflict) {
          toast.info(t('gitView.toast.restoreStashManually'));
        }

        await refreshStatusAndBranches();
        await refreshLog();
      } catch (err) {
        if (restoreAfter) {
          try {
            await git.stashPop(gitDirectory);
            bumpIndexRevision(gitDirectory);
          } catch {
            // Ignore stash pop errors in this case
          }
        }
        throw err;
      }
    },
    [bumpIndexRevision, gitDirectory, git, status, stashDialogOperation, stashDialogBranch, stashDialogBranchLabel, refreshStatusAndBranches, refreshLog, t]
  );

  const handleLogMaxCountChange = React.useCallback(
    (count: number) => {
      setLogMaxCountLocal(count);
      if (gitDirectory) {
        setLogMaxCount(gitDirectory, count);
        fetchLog(gitDirectory, git, count);
      }
    },
    [gitDirectory, fetchLog, git, setLogMaxCount]
  );

  const handleGraphLogMaxCountChange = React.useCallback((count: number) => {
    setGraphLogMaxCount(count);
  }, []);

  const handleGraphActionSuccess = React.useCallback(() => {
    setGitLogDialogMode(null);
    if (gitDirectory) {
      fetchStatus(gitDirectory, git);
      fetchBranches(gitDirectory, git);
      fetchLog(gitDirectory, git, logMaxCountLocal);
    }
  }, [gitDirectory, fetchStatus, fetchBranches, fetchLog, logMaxCountLocal, git]);

  const handleGraphConflict = React.useCallback((result: {
    conflict: boolean;
    conflictFiles?: string[];
    operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase';
  }) => {
    if (!result.conflict) return;

    if (result.operation === 'cherry-pick' || result.operation === 'revert') {
      toast.error(t('gitView.history.actions.conflictToastTitle'), {
        description: t('gitView.history.actions.conflictToastDescription', {
          files: result.conflictFiles?.join(', ') ?? 'unknown files',
        }),
      });
      if (gitDirectory) {
        fetchStatus(gitDirectory, git);
        fetchBranches(gitDirectory, git);
        fetchLog(gitDirectory, git, logMaxCountLocal);
      }
      return;
    }

    openConflictDialog(result.conflictFiles ?? [], result.operation);
  }, [t, openConflictDialog, gitDirectory, fetchStatus, fetchBranches, fetchLog, logMaxCountLocal, git]);

  if (draftSpace?.kind === 'preparing') {
    return <SpacePreparing />;
  }

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          {t('gitView.empty.selectSessionOrDirectory')}
        </p>
      </div>
    );
  }

  if (shouldHideGitState) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        {!postBootstrapRefreshFailed ? (
          <Spinner className="mb-3 size-6 text-muted-foreground" />
        ) : null}
        <p className="typography-ui-label font-semibold text-foreground">
          {postBootstrapRefreshFailed
            ? t('gitView.toast.refreshRepositoryFailed')
            : t('gitView.empty.worktreeSetupInProgress')}
        </p>
        {!postBootstrapRefreshFailed ? (
          <p className="typography-meta mt-1 text-muted-foreground">
            {t('gitView.empty.worktreeSetupDescription')}
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              if (!normalizedCurrentBootstrapDirectory) return;
              setPostBootstrapRefresh({
                directory: normalizedCurrentBootstrapDirectory,
                status: 'refreshing',
              });
            }}
          >
            {t('gitView.empty.retryDiscovery')}
          </Button>
        )}
      </div>
    );
  }

  if (unreadable) {
    return <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />;
  }

  if (isGitRepo === null || (isGitRepo === true && !status)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="typography-ui-label">{t('gitView.loading.checkingRepository')}</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    return (
      <NestedRepoResolutionStates
        root={currentDirectory}
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          if (currentDirectory) {
            void ensureNestedRepos(currentDirectory, { force: true });
          }
        }}
        emptyStateFooter={
          repairActions.includes('open-without-worktree-features') ? (
            <p className="typography-meta mt-2 text-muted-foreground">
              {t('gitView.empty.worktreeFeaturesUnavailable')}
            </p>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden')}>
           <GitHeader
        directory={gitDirectory ?? ''}
        status={status}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={branches?.branches}
        syncAction={operationRecovery.entry?.executing ? syncAction : null}
        operationBlocked={operationRecovery.blocked}
        remotes={remotes}
        onFetch={(remote) => handleSyncAction('fetch', remote)}
        onPull={(remote) => handleSyncAction('pull', remote)}
        onSync={(remote) => handleSyncAction('sync', remote)}
        onPublish={() => void handleSyncAction('publish')}
        onChooseSyncTargets={() => void handleSyncAction('sync', undefined, true)}
        onRemoveRemote={handleRemoveRemote}
        removingRemoteName={removingRemoteName}
        onCheckoutBranch={handleCheckoutBranch}
        onCreateBranch={handleCreateBranch}
        onRenameBranch={handleRenameBranch}
        activeIdentityProfile={activeIdentityProfile}
        availableIdentities={availableIdentities}
        onSelectIdentity={handleApplyIdentity}
        isApplyingIdentity={isSettingIdentity}
        identityAttention={identityAttention}
        identityApplicability={identityApplicabilityOf}
        onConfigureRepository={runtime.isVSCode ? undefined : () => setRepositoryConfigurationOpen(true)}
        onIdentityMenuOpen={() => void refreshIdentityAccounts(sourceControl, profiles.map((profile) => profile.account))}
            isWorktreeMode={!!worktreeMetadata}
            onOpenHistory={() => setGitLogDialogMode('history')}
            onOpenGraph={() => setGitLogDialogMode('graph')}
            onOpenStashes={openStashes}
            onOpenUpdateBranch={canShowBranchWorkflows ? () => setIsUpdateBranchDialogOpen(true) : undefined}
            onOpenReintegrateCommits={integrateCommitsProps ? () => setIsIntegrateCommitsDialogOpen(true) : undefined}
            pullRequest={prChipStatus?.changeRequest ?? prChipStatus?.pr ?? null}
            pullRequestProvider={prChipStatus?.changeRequest?.provider ?? null}
            prChecks={prChipStatus?.ci?.summary ?? prChipStatus?.checks ?? null}
            pullRequestStack={prChipStatus?.stack ?? null}
            onOpenPullRequest={
              gitDirectory ? () => openContextPanelTab(panelDirectory ?? gitDirectory, { mode: 'pr' }) : undefined
            }
            repositoryOptions={repositoryOptions ?? undefined}
            selectedRepository={repositoryOptions ? gitDirectory : null}
            onSelectRepository={
              repositoryOptions && currentDirectory
                ? (repository) => selectNestedRepo(currentDirectory, repository)
                : undefined
            }
            repositoryRoot={repositoryOptions ? currentDirectory ?? undefined : undefined}
          />

      {!runtime.isVSCode ? <RepositoryConfigurationDialog
        open={isRepositoryConfigurationOpen}
        onOpenChange={setRepositoryConfigurationOpen}
        directory={isActive ? gitDirectory ?? '' : ''}
      /> : null}
      <GitOperationStatus className="mx-4 mt-3" entry={operationRecovery.entry} onRefresh={() => void operationRecovery.refresh()} onCancel={() => void operationRecovery.cancel()} />

      {currentDirectory && (
        (status?.mergeInProgress?.head) ||
        (status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto)
      ) && (
          <InProgressOperationBanner
            mergeInProgress={status?.mergeInProgress}
            rebaseInProgress={status?.rebaseInProgress}
            onContinue={handleContinueOperation}
            onAbort={handleAbortOperation}
            onResolveWithAI={handleResolveWithAIFromBanner}
            conflictCount={conflictCount}
            isLoading={isLoading}
          />
        )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className={cn('min-w-0 min-h-0 h-full flex flex-col')}>
            <ScrollableOverlay
              useScrollShadow
              scrollShadowSurface="var(--background)"
              ref={actionPanelScrollRef}
              outerClassName="flex-1 min-h-0"
              className={cn('px-4', 'pt-1 pb-4')}
              disableHorizontal
              preventOverscroll
            >
              <div className="flex h-full min-h-0 flex-col gap-3">
                  {(changeEntries?.length ?? 0) > 0 ? (
                    <>
                      <div className="min-h-0 flex-1 overflow-hidden" aria-busy={hasPendingIndexMutation || undefined}>
                        <ChangesPanel
                          groups={changeGroups}
                          diffStats={status?.diffStats}
                          revertingPaths={revertingPaths}
                          isRevertingAll={isRevertingAll}
                          onVisiblePathsChange={setVisibleChangePaths}
                          onRevertAll={handleRevertAll}
                          onRevertDirectory={handleRevertDirectory}
                          headerBackgroundClassName="bg-background"
                          scrollSurface="var(--background)"
                        />
                      </div>

                      <CommitSection
                        stagedCount={stagedCount}
                        commitMessage={commitMessage}
                        onCommitMessageChange={setCommitMessage}
                        generatedHighlights={generatedHighlights}
                        onInsertHighlights={handleInsertHighlights}
                        onGenerateMessage={handleGenerateCommitMessage}
                        isGeneratingMessage={isGeneratingMessage}
                        onCommit={(origin) => handleCommit({ pushAfter: false, origin })}
                        onCommitAndPush={(origin) => handleCommit({ pushAfter: true, origin })}
                        commitAction={commitAction}
                        networkOperationBlocked={operationRecovery.blocked}
                        hasPendingIndexMutation={hasPendingIndexMutation}
                        gitmojiEnabled={settingsGitmojiEnabled}
                        onOpenGitmojiPicker={() => setIsGitmojiPickerOpen(true)}
                      />
                    </>
                  ) : (
                      <GitEmptyState key={opening.count} onOpenStashes={() => setIsStashesDialogOpen(true)} />
                  )}
                </div>
            </ScrollableOverlay>
          </div>
        </div>
      </div>

      <Dialog
        open={isUpdateBranchDialogOpen}
        onOpenChange={(open) => {
          if (!open && branchOperation !== null) {
            return;
          }
          setIsUpdateBranchDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl min-h-[26rem]">
          <DialogHeader>
            <DialogTitle>{t('gitView.branch.updateTitle')}</DialogTitle>
            <DialogDescription>
              {t('gitView.branch.updateDescriptionPrefix')}{' '}
              <span className="font-mono text-foreground">{status?.current ?? ''}</span>.
            </DialogDescription>
          </DialogHeader>
          {canShowBranchWorkflows ? (
            <BranchIntegrationSection
              mode="bare"
              currentBranch={status?.current}
              localBranches={localBranches}
              remoteBranches={branchIntegrationRemoteBranches}
              defaultTargetBranch={updateTargetBranch}
              onMerge={handleMerge}
              onRebase={handleRebase}
              disabled={isBusy || operationRecovery.blocked}
              isOperating={branchOperation !== null}
              operationLogs={operationLogs}
              onOperationComplete={handleOperationComplete}
            />
          ) : (
            <p className="typography-meta text-muted-foreground">{t('gitView.branch.actionsUnavailable')}</p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={isIntegrateCommitsDialogOpen} onOpenChange={setIsIntegrateCommitsDialogOpen}>
        <DialogContent className="max-w-2xl min-h-[26rem]">
          <DialogHeader>
            <DialogTitle>{t('gitView.integrate.title')}</DialogTitle>
            <DialogDescription>
              {integrateCommitsProps ? (
                <span className="font-mono text-foreground">
                  {integrateCommitsProps.sourceBranch} → {defaultTargetBranch}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {integrateCommitsProps ? (
            <IntegrateCommitsSection
              key={integrateCommitsProps.worktreeMetadata.path}
              repoRoot={integrateCommitsProps.repoRoot}
              sourceBranch={integrateCommitsProps.sourceBranch}
              worktreeMetadata={integrateCommitsProps.worktreeMetadata}
              localBranches={localBranches}
              defaultTargetBranch={defaultTargetBranch}
              refreshKey={integrateRefreshKey}
              showHeader={false}
              onRefresh={() => {
                if (!gitDirectory) return;
                fetchStatus(gitDirectory, git);
                fetchBranches(gitDirectory, git);
                fetchLog(gitDirectory, git, logMaxCountLocal);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={gitLogDialogMode !== null} onOpenChange={(open) => { if (!open) setGitLogDialogMode(null); }}>
        <DialogContent className="max-w-5xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>
                {gitLogDialogMode === 'graph' ? t('gitView.graph.title') : t('gitView.history.title')}
              </DialogTitle>
              <ButtonTooltip label={t('contextTooltips.git.reloadCommits')} side="bottom" className="shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="me-6 h-7 shrink-0 gap-1.5 px-2"
                  onClick={() => {
                    if (gitLogDialogMode === 'graph') {
                      setGraphLogRefreshToken((token) => token + 1);
                      return;
                    }
                    if (!gitDirectory) return;
                    void fetchLog(gitDirectory, git, logMaxCountLocal);
                  }}
                  disabled={gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading}
                  aria-label={t('gitView.history.refresh')}
                >
                  <Icon
                    name="refresh"
                    className={cn(
                      'size-4',
                      (gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading) && 'animate-spin'
                    )}
                  />
                  {t('gitView.history.refresh')}
                </Button>
              </ButtonTooltip>
            </div>
            <DialogDescription>
              {t('gitView.history.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <HistorySection
              mode={gitLogDialogMode === 'graph' ? 'graph' : 'history'}
              log={gitLogDialogMode === 'graph' ? graphLog ?? log : log}
              isLogLoading={gitLogDialogMode === 'graph' ? graphLogLoading || isLogLoading : isLogLoading}
              logMaxCount={gitLogDialogMode === 'graph' ? graphLogMaxCount : logMaxCountLocal}
              onLogMaxCountChange={gitLogDialogMode === 'graph' ? handleGraphLogMaxCountChange : handleLogMaxCountChange}
              expandedCommitHashes={expandedCommitHashes}
              onToggleCommit={handleToggleCommit}
              commitFilesMap={commitFilesMap}
              loadingCommitHashes={loadingCommitHashes}
              onCopyHash={handleCopyCommitHash}
              directory={gitDirectory ?? undefined}
              showHeader={false}
              contentMaxHeightClassName="h-full max-h-none"
              branchDivider={gitLogDialogMode === 'graph' ? null : historyBranchDivider}
              onConflict={gitLogDialogMode === 'graph' ? handleGraphConflict : undefined}
              onActionSuccess={gitLogDialogMode === 'graph' ? handleGraphActionSuccess : undefined}
            />
          </div>
        </DialogContent>
      </Dialog>

      <StashesDialog
        open={isStashesDialogOpen}
        onOpenChange={setIsStashesDialogOpen}
        directory={gitDirectory}
        hasUncommittedChanges={(status?.files?.length ?? 0) > 0}
        hasStagedChanges={stagedChangeEntries.length > 0}
        uncommittedFileCount={status?.files?.length ?? 0}
        onChanged={async (change) => {
          if (gitDirectory && change?.affectsIndex) {
            bumpIndexRevision(gitDirectory);
          }
          await refreshStatusAndBranches(false);
          await refreshLog();
        }}
      />

      <Dialog open={isGitmojiPickerOpen} onOpenChange={setIsGitmojiPickerOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>{t('gitView.gitmoji.title')}</DialogTitle>
          </DialogHeader>
          {/* external: https://github.com/dip/cmdk#command-commandmenu Disable cmdk filtering to preserve rankByQuery's ordering. */}
          <Command className="h-[420px]" shouldFilter={false}>
            <CommandInput
              placeholder={t('gitView.gitmoji.searchPlaceholder')}
              value={gitmojiSearch}
              onValueChange={setGitmojiSearch}
            />
            <CommandList>
              <CommandEmpty>{t('gitView.gitmoji.empty')}</CommandEmpty>
              <CommandGroup>
                {rankByQuery(gitmojiEmojis, gitmojiSearch, (entry) => [entry.code, entry.description, entry.emoji]).map((entry) => (
                  <CommandItem
                    key={entry.code}
                    onSelect={() => handleSelectGitmoji(entry.emoji, entry.code)}
                  >
                    <span className="text-lg">{entry.emoji}</span>
                    <span className="typography-ui-label text-foreground">{entry.code}</span>
                    <span className="typography-meta text-muted-foreground">{entry.description}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {publishChooser.context ? <PublishDialog context={publishChooser.context} onSelect={publishChooser.settle} /> : null}
      {publishChooser.confirmDialog}
      <ContributorDestinationDialog
        candidates={contributorDestination.candidates}
        onSelect={contributorDestination.settle}
      />

      {gitDirectory && (
        <ConflictDialog
          open={conflictDialogOpen}
          onOpenChange={setConflictDialogOpen}
          conflictFiles={conflictFiles}
          directory={gitDirectory}
          operation={conflictOperation}
          onAbort={handleAbortConflict}
          onClearState={clearConflictState}
        />
      )}

      <DirtyBranchSwitchDialog
        open={pendingDirtySwitchBranch !== null}
        onOpenChange={(open) => { if (!open) setPendingDirtySwitchBranch(null); }}
        targetBranch={pendingDirtySwitchBranch ?? ''}
        changedFileCount={status?.files?.length ?? 0}
        onCommitAndSwitch={async (message, pushAfter) => {
          const branch = pendingDirtySwitchBranch;
          if (!branch || !gitDirectory) return;
          const sourceBranch = status?.current ?? null;
          if (!git.createGitCommit) throw new Error('Git commit is unavailable on this runtime');
          await git.createGitCommit(gitDirectory, message, { addAll: true });
          bumpIndexRevision(gitDirectory);
          let pushedRemoteName: string | null = null;
          if (pushAfter) {
            const knownRemoteNames = binding.read?.repository.remotes.map((entry) => entry.name)
              ?? remotes.map((entry) => entry.name);
            const target = sourceBranch
              ? dirtySwitchPushTarget(sourceBranch, status?.tracking, knownRemoteNames, binding.contexts[0]?.primaryRemote ?? knownRemoteNames[0] ?? null)
              : null;
            try {
              if (!target || !sourceBranch) throw new Error(t('mobile.changes.noRemote'));
              await runContributorAwarePush({
                directory: gitDirectory,
                branch: sourceBranch,
                remoteName: target.remoteName,
                sourceControl,
                git,
                choose: contributorDestination.choose,
                destinationRef: target.destinationRef,
              });
              pushedRemoteName = target.remoteName;
            } catch (error) {
              console.error('Push after commit failed:', error);
              toast.error(t('gitView.dirtySwitch.pushFailed'));
              await refreshStatusAndBranches();
              await refreshLog();
              setPendingDirtySwitchBranch(null);
              return;
            }
          }
          toast.success(pushedRemoteName
            ? t('gitView.toast.pushedToUpstream', { name: pushedRemoteName })
            : sourceBranch
              ? t('gitView.dirtySwitch.committedNotPushed', { branch: sourceBranch })
              : t('gitView.toast.commitCreated'));
          await refreshStatusAndBranches();
          await refreshLog();
          setPendingDirtySwitchBranch(null);
          await performCheckout(branch);
        }}
        onGenerateMessage={async () => {
          if (!gitDirectory) return '';
          const paths = (status?.files ?? []).map((file) => file.path).sort();
          const { message } = await generateSessionCommitMessage(gitDirectory, paths);
          const subject = message.subject?.trim() ?? '';
          if (subject && settingsGitmojiEnabled && gitmojiEmojis.length > 0) {
            const match = matchGitmojiFromSubject(subject, gitmojiEmojis);
            if (match && !subject.startsWith(match.code) && !subject.startsWith(match.emoji)) {
              return `${match.code} ${subject}`;
            }
          }
          return subject;
        }}
        onRevertAndSwitch={async () => {
          const branch = pendingDirtySwitchBranch;
          if (!branch || !gitDirectory) return;
          const paths = (status?.files ?? []).map((file) => file.path);
          await handleRevertPaths(paths, true, 'all');
          const fresh = await git.getGitStatus(gitDirectory);
          if (!fresh.isClean && (fresh.files?.length ?? 0) > 0) {
            toast.error(t('gitView.dirtySwitch.revertIncomplete'));
            return;
          }
          setPendingDirtySwitchBranch(null);
          await performCheckout(branch);
        }}
      />

      <StashDialog
        open={stashDialogOpen}
        onOpenChange={setStashDialogOpen}
        operation={stashDialogOperation}
        targetBranch={stashDialogBranchLabel || stashDialogBranch}
        onConfirm={handleStashAndRetry}
      />

    </div>
  );
};
