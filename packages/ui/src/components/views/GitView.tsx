import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import type { GitIdentityProfile, CommitFileEntry, GitStatus } from '@/lib/api/types';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitmojiList } from '@/hooks/useGitmojiList';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useGitIdentity,
  useIsGitRepo,
  useGitLoadingStatus,
  useGitLoadingLog,
  useEffectiveGitDirectory,
  useNestedRepos,
  useNestedRepoSelection,
} from '@/stores/useGitStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
// (dropdown menu used inside IntegrateCommitsSection)
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getSessionWorktreeRepairActions, getMutationBlockingReasons } from '@/sync/session-worktree-contract';
import { IntegrateCommitsSection } from './git/IntegrateCommitsSection';

import { GitHeader } from './git/GitHeader';
import { StashesDialog } from './git/StashesDialog';
import { ChangesPanel, type ChangesGroupConfig } from './git/ChangesPanel';
import { CommitSection } from './git/CommitSection';
import { GitEmptyState } from './git/GitEmptyState';
import { HistorySection } from './git/HistorySection';
import { ConflictDialog } from './git/ConflictDialog';
import { StashDialog } from './git/StashDialog';
import { InProgressOperationBanner } from './git/InProgressOperationBanner';
import { BranchIntegrationSection, type OperationLogEntry } from './git/BranchIntegrationSection';
import { deriveBaseBranch } from './git/baseBranch';
import { getFreshestPrStatusForBranch, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { createGitIndexMutationQueue, type GitIndexMutationDirection, type GitIndexMutationQueue } from './git/gitIndexMutationQueue';
import type { GitRemote } from '@/lib/gitApi';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { cn } from '@/lib/utils';
import { generateCommitMessage as generateSessionCommitMessage, getGitWorktreeBootstrapStatus } from '@/lib/gitApi';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
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

  // 1. Check for conventional commit prefix (e.g. "feat:", "fix(scope):")
  const conventionalRegex = /^([a-z]+)(?:\(.*\))?!?:/;
  const match = lowerSubject.match(conventionalRegex);

  if (match) {
    const type = match[1];
    // Map common types to gitmoji codes
    const mappedCode = KEYWORD_MAP[type];
    if (mappedCode) {
      return gitmojis.find((g) => g.code === mappedCode) || null;
    }
  }

  // 2. Check for starting words (e.g. "Add", "Fix")
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
  // Touch-on-write LRU: deleting before re-inserting promotes the key to
  // the Map's insertion order, so the oldest key falls off the end.
  gitViewSnapshots.delete(key);
  gitViewSnapshots.set(key, snapshot);
  if (gitViewSnapshots.size > GIT_VIEW_SNAPSHOTS_CAP) {
    const oldest = gitViewSnapshots.keys().next().value;
    if (oldest !== undefined) {
      gitViewSnapshots.delete(oldest);
    }
  }
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

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
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const [worktreeBootstrapStatus, setWorktreeBootstrapStatus] = React.useState<'pending' | 'ready' | 'failed' | null>(null);
  const [isWaitingForGitRefreshAfterBootstrap, setIsWaitingForGitRefreshAfterBootstrap] = React.useState(false);
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

  const { profiles, globalIdentity, defaultGitIdentityId, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId } =
    useGitIdentitiesStore(useShallow((s) => ({
      profiles: s.profiles,
      globalIdentity: s.globalIdentity,
      defaultGitIdentityId: s.defaultGitIdentityId,
      loadProfiles: s.loadProfiles,
      loadGlobalIdentity: s.loadGlobalIdentity,
      loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    })));

  // The root the view is anchored to (session/worktree context stays keyed on
  // it). When the root is not itself a repository and the user picked a nested
  // one, `gitDirectory` is the effective repository all git data and actions
  // operate on.
  const rootIsGitRepo = useIsGitRepo(currentDirectory ?? null);
  const gitDirectory = useEffectiveGitDirectory(currentDirectory ?? null);
  const isGitRepo = useIsGitRepo(gitDirectory ?? null);
  const status = useGitStatus(gitDirectory ?? null);
  const nestedRepos = useNestedRepos(currentDirectory ?? null);
  const nestedRepoSelection = useNestedRepoSelection(currentDirectory ?? null);

  // Authoritative session↔worktree attachment for repair action display
  const worktreeAttachment = useSessionWorktreeStore((s) =>
    currentSessionId ? s.getAttachment(currentSessionId) : undefined
  );
  const repairActions = worktreeAttachment ? getSessionWorktreeRepairActions(worktreeAttachment) : [];

  // When an authoritative attachment exists, derive worktree-related fields from it
  // rather than from the live detected worktree metadata.
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
    fetchAll,
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
    clearNestedRepoSelection,
  } = useGitStore(useShallow((state) => ({
    setActiveDirectory: state.setActiveDirectory,
    fetchAll: state.fetchAll,
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
    clearNestedRepoSelection: state.clearNestedRepoSelection,
  })));
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextDiff = useUIStore((state) => state.openContextDiff);
  const openContextSurface = useUIStore((state) => state.openContextSurface);

  const prStatusBranch = status?.current ?? null;
  const prChipStatus = useGitHubPrStatusStore((state) => {
    if (!gitDirectory || !prStatusBranch) {
      return null;
    }
    return getFreshestPrStatusForBranch(state.entries, gitDirectory, prStatusBranch);
  });
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  const previousBootstrapStatusRef = React.useRef<'pending' | 'ready' | 'failed' | null>(null);
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
      setWorktreeBootstrapStatus(null);
      setIsWaitingForGitRefreshAfterBootstrap(false);
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const next = await getGitWorktreeBootstrapStatus(currentDirectory);
        if (cancelled) {
          return;
        }
        setWorktreeBootstrapStatus(next.status);
        if (next.status === 'pending') {
          timeoutId = window.setTimeout(() => {
            void poll();
          }, 500);
        }
      } catch {
        if (!cancelled) {
          setWorktreeBootstrapStatus(null);
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

  React.useEffect(() => {
    const previous = previousBootstrapStatusRef.current;
    previousBootstrapStatusRef.current = worktreeBootstrapStatus;

    if (!currentDirectory || !git) {
      return;
    }

    if (previous === 'pending' && worktreeBootstrapStatus === 'ready') {
      setIsWaitingForGitRefreshAfterBootstrap(true);
      void fetchAll(currentDirectory, git).finally(() => {
        window.setTimeout(() => {
          setIsWaitingForGitRefreshAfterBootstrap(false);
        }, 1200);
      });
    }

    if (worktreeBootstrapStatus === 'failed') {
      setDraftBootstrapPendingDirectory(null);
      setIsWaitingForGitRefreshAfterBootstrap(false);
    }
  }, [currentDirectory, fetchAll, git, setDraftBootstrapPendingDirectory, worktreeBootstrapStatus]);

  const normalizedDraftBootstrapPendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
  const isDraftBootstrapPendingForCurrentDirectory = Boolean(
    currentDirectory && normalizedDraftBootstrapPendingDirectory && normalizedDraftBootstrapPendingDirectory === normalizePath(currentDirectory)
  );
  const isPendingWorktreeSetup = Boolean(
    currentDirectory && (worktreeBootstrapStatus === 'pending' || isDraftBootstrapPendingForCurrentDirectory)
  );
  const shouldHideNotGitState = isPendingWorktreeSetup || isWaitingForGitRefreshAfterBootstrap;

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
  const { triggerFireworks } = useFireworksCelebration();

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
    // For PR worktrees from forks we set upstream to a non-origin remote (e.g. pr-<owner>-<repo>).
    // Re-integrate commits is intended for local scratch branches -> base branch, not fork PR branches.
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
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [gitmojiSearch, setGitmojiSearch] = React.useState('');
  const [gitLogDialogMode, setGitLogDialogMode] = React.useState<GitLogDialogMode | null>(null);

  const [isUpdateBranchDialogOpen, setIsUpdateBranchDialogOpen] = React.useState(false);
  const [isIntegrateCommitsDialogOpen, setIsIntegrateCommitsDialogOpen] = React.useState(false);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
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

  // Conflict state persistence key
  const conflictStorageKey = React.useMemo(() => {
    if (!currentSessionId) return null;
    return `openchamber.conflict:${currentSessionId}`;
  }, [currentSessionId]);

  // Save conflict state to localStorage
  const persistConflictState = React.useCallback((
    directory: string,
    files: string[],
    operation: 'merge' | 'rebase'
  ) => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    const payload = { directory, conflictFiles: files, operation };
    window.localStorage.setItem(conflictStorageKey, JSON.stringify(payload));
  }, [conflictStorageKey]);

  // Clear conflict state from localStorage
  const clearConflictState = React.useCallback(() => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    window.localStorage.removeItem(conflictStorageKey);
  }, [conflictStorageKey]);

  // Restore conflict state from localStorage on mount
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

      // Validate the stored state matches the effective repository
      if (parsed.directory !== gitDirectory) {
        window.localStorage.removeItem(conflictStorageKey);
        return;
      }

      // Restore conflict state
      setConflictFiles(parsed.conflictFiles ?? []);
      setConflictOperation(parsed.operation ?? 'merge');
      setConflictDialogOpen(true);
    } catch {
      window.localStorage.removeItem(conflictStorageKey);
    }
  }, [conflictStorageKey, gitDirectory]);
  const [stashDialogOpen, setStashDialogOpen] = React.useState(false);
  const [stashDialogOperation, setStashDialogOperation] = React.useState<'merge' | 'rebase'>('merge');
  const [stashDialogBranch, setStashDialogBranch] = React.useState('');

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

    // Find hashes that are expanded but not yet loaded or loading
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
        git
          .getCommitFiles(gitDirectory, hash)
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

  // Restore the per-repository draft when the effective repository changes
  // (e.g. the user picks a different nested repository from the picker),
  // mirroring the fresh-mount behavior of a directory switch.
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

  React.useEffect(() => {
    if (!isActive) return;
    if (!gitDirectory || !git?.getRemoteUrl || isGitRepo !== true) {
      setRemoteUrl(null);
      return;
    }
    let cancelled = false;
    git
      .getRemoteUrl(gitDirectory)
      .then((url) => { if (!cancelled) setRemoteUrl(url); })
      .catch(() => { if (!cancelled) setRemoteUrl(null); });
    return () => { cancelled = true; };
  }, [isActive, gitDirectory, git, isGitRepo]);

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

  // Discover nested repositories once the root probe confirms it is not one.
  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) return;
    if (rootIsGitRepo !== false) return;
    void ensureNestedRepos(currentDirectory);
  }, [currentDirectory, ensureNestedRepos, isActive, rootIsGitRepo]);

  // Auto-select the first nested repository so the tab opens straight into
  // repository data; the header picker switches between repositories.
  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) return;
    if (rootIsGitRepo !== false) return;
    if (!nestedRepos || nestedRepos.length === 0) return;
    if (nestedRepoSelection) return;
    selectNestedRepo(currentDirectory, nestedRepos[0]);
  }, [currentDirectory, isActive, nestedRepos, nestedRepoSelection, rootIsGitRepo, selectNestedRepo]);

  // A selected repository that is no longer a git repository is stale: drop
  // the selection and re-scan so the picker reflects the current tree.
  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) return;
    if (!nestedRepoSelection) return;
    if (gitDirectory === currentDirectory) return;
    if (isGitRepo !== false) return;
    clearNestedRepoSelection(currentDirectory);
    void ensureNestedRepos(currentDirectory, { force: true });
  }, [clearNestedRepoSelection, currentDirectory, ensureNestedRepos, gitDirectory, isActive, isGitRepo, nestedRepoSelection]);

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

    const previousAttempt = autoAppliedDefaultRef.current.get(gitDirectory);
    if (previousAttempt === defaultId) return;

    let cancelled = false;

    const run = async () => {
      try {
        const hasLocal = await git.hasLocalIdentity?.(gitDirectory);
        if (cancelled) return;
        if (hasLocal === true) return;

        beginIdentityApply();
        await git.setGitIdentity(gitDirectory, defaultId);
        autoAppliedDefaultRef.current.set(gitDirectory, defaultId);
        await refreshIdentity();
      } catch (error) {
        console.warn('Failed to auto-apply default git identity:', error);
      } finally {
        if (!cancelled) {
          endIdentityApply();
        }
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
    // GitStatus.files is already unique by `path` per the server contract;
    // a defensive dedup pass would only mask real upstream bugs.
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
    if (!gitDirectory || changeEntries.length === 0) {
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
  }, [changeEntries, gitDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  const getPushedRemoteName = (result?: Awaited<ReturnType<typeof git.gitPush>>) => {
    return result?.pushed[0]?.remote
      || status?.tracking?.split('/')[0]
      || effectiveRemotes.find((remote) => remote.name === 'origin')?.name
      || effectiveRemotes[0]?.name
      || 'origin';
  };

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!gitDirectory) return;
    setSyncAction(action);

    try {
      const getPullOptions = (pullRemote: GitRemote) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;
        return {
          remote: pullRemote.name,
          branch: trackedBranch,
          rebase: true,
        };
      };

      if (action === 'fetch') {
        if (!remote) {
          throw new Error('No remote available for fetch');
        }
        await git.gitFetch(gitDirectory, { remote: remote.name });
        toast.success(t('gitView.toast.fetchedFromRemote', { name: remote.name }));
      } else if (action === 'pull') {
        if (!remote) {
          throw new Error('No remote available for pull');
        }
        const result = await git.gitPull(gitDirectory, getPullOptions(remote));
        toast.success(
          result.files.length === 1
            ? t('gitView.toast.pulledFilesSingle', { count: result.files.length, name: remote.name })
            : t('gitView.toast.pulledFilesPlural', { count: result.files.length, name: remote.name })
        );
      } else if (action === 'push') {
        const result = await git.gitPush(gitDirectory);
        toast.success(t('gitView.toast.pushedToUpstream', { name: getPushedRemoteName(result) }));
      } else if (action === 'sync') {
        if (!remote) {
          throw new Error('No remote available for sync');
        }
        let pulledFileCount = 0;
        let pushedChanges = false;
        await git.gitFetch(gitDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(gitDirectory);

        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error(t('gitView.toast.commitOrStashBeforeSync'));
            return;
          }
          const pullResult = await git.gitPull(gitDirectory, getPullOptions(remote));
          pulledFileCount = pullResult.files.length;
        }

        const afterPull = await git.getGitStatus(gitDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(gitDirectory);
          pushedChanges = true;
        }
        if (pulledFileCount > 0 && pushedChanges) {
          toast.success(
            pulledFileCount === 1
              ? t('gitView.toast.syncedPulledSingleAndPushed', { count: pulledFileCount, name: remote.name })
              : t('gitView.toast.syncedPulledPluralAndPushed', { count: pulledFileCount, name: remote.name })
          );
        } else if (pulledFileCount > 0) {
          toast.success(
            pulledFileCount === 1
              ? t('gitView.toast.pulledFilesSingle', { count: pulledFileCount, name: remote.name })
              : t('gitView.toast.pulledFilesPlural', { count: pulledFileCount, name: remote.name })
          );
        } else if (pushedChanges) {
          toast.success(t('gitView.toast.pushedToUpstream', { name: remote.name }));
        } else {
          toast.success(t('gitView.toast.alreadyUpToDate'));
        }
      }

      await refreshStatusAndBranches(false);
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('gitView.toast.syncActionFailed', { action: action === 'sync' ? t('gitView.sync.syncChanges') : action === 'pull' ? t('gitView.sync.pull') : action });
      toast.error(message);
    } finally {
      setSyncAction(null);
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

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
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

    try {
      await git.createGitCommit(gitDirectory, commitMessage.trim(), {
        files: filesToCommit,
        stageFiles: [],
      });
      bumpIndexRevision(gitDirectory);
      toast.success(t('gitView.toast.commitCreated'));
      setCommitMessage('');
      clearGeneratedHighlights();

      await refreshStatusAndBranches();

      if (options.pushAfter) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!remote) {
          throw new Error(t('mobile.changes.noRemote'));
        }

        setSyncAction('sync');
        const trackingPrefix = `${remote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;

        await git.gitFetch(gitDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(gitDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error(t('gitView.toast.commitOrStashBeforeSync'));
            await refreshStatusAndBranches(false);
            return;
          }
          await git.gitPull(gitDirectory, { remote: remote.name, branch: trackedBranch, rebase: true });
        }

        const afterPull = await git.getGitStatus(gitDirectory);
        let result: Awaited<ReturnType<typeof git.gitPush>> | undefined;
        if ((afterPull.ahead ?? 0) > 0) {
          result = await git.gitPush(gitDirectory);
        }
        toast.success(t('gitView.toast.pushedToUpstream', { name: getPushedRemoteName(result) }));
        triggerFireworks();
        await refreshStatusAndBranches(false);
      } else {
        await refreshStatusAndBranches(false);
      }

      await refreshLog();
      setIntegrateRefreshKey((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('gitView.toast.createCommitFailed');
      toast.error(message);
    } finally {
      setCommitAction(null);
      if (options.pushAfter) {
        setSyncAction(null);
      }
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

  const handleCreateBranch = async (branchName: string, remote?: GitRemote) => {
    if (!gitDirectory || !status) return;

    const blockingReasons = getMutationBlockingReasons(worktreeAttachment);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotCreateBranch', { reason: formatBlockingReason(blockingReasons[0]) }));
      return;
    }

    const checkoutBase = status.current ?? null;
    const remoteName = remote?.name ?? 'origin';

    try {
      await git.createBranch(gitDirectory, branchName, checkoutBase ?? 'HEAD');
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));

      // Checkout the new branch and stay on it
      await git.checkoutBranch(gitDirectory, branchName);

      let pushSucceeded = false;
      try {
        await git.gitPush(gitDirectory, {
          remote: remoteName,
          branch: branchName,
          options: ['--set-upstream'],
        });
        pushSucceeded = true;
      } catch (pushError) {
        const message =
          pushError instanceof Error
            ? pushError.message
            : `Unable to push new branch to ${remoteName}.`;
        toast.warning(t('gitView.toast.branchCreatedLocally'), {
          description: (
            <span className="text-foreground/80 dark:text-foreground/70">
              Upstream setup failed: {message}
            </span>
          ),
        });
      }

      await refreshStatusAndBranches();
      await refreshLog();

      if (pushSucceeded) {
        toast.success(t('gitView.toast.upstreamSet', { branch: branchName, remote: remoteName }));
      }
    } catch (err) {
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

    // Block mutation if worktree is in an attention-required state
    const blockingReasons = getMutationBlockingReasons(worktreeAttachment);
    if (blockingReasons.length > 0) {
      toast.error(t('gitView.toast.cannotCheckout', { reason: formatBlockingReason(blockingReasons[0]) }));
      return;
    }

    const normalized = branch.replace(/^remotes\//, '');

    if (status?.current === normalized) {
      return;
    }

    try {
      await git.checkoutBranch(gitDirectory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: normalized }));
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
    beginIdentityApply();

    try {
      await git.setGitIdentity(gitDirectory, profile.id);
      toast.success(t('gitView.toast.appliedIdentity', { name: profile.name }));
      await refreshIdentity();
    } catch (err) {
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

  // The repository's own default branch, so a repo whose default is neither
  // main, master nor develop stops being compared against a branch that does
  // not exist.
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

  const updateTargetBranch = React.useMemo(() => {
    const remoteNames = effectiveRemotes.map((remote) => remote.name);
    const remoteCandidates = remoteNames.map((remote) => `${remote}/${baseBranch}`);
    return remoteCandidates.find((candidate) => remoteBranches.includes(candidate)) ?? baseBranch;
  }, [baseBranch, effectiveRemotes, remoteBranches]);

  const availableIdentities = React.useMemo(() => {
    const unique = new Map<string, GitIdentityProfile>();
    if (globalIdentity) {
      unique.set(globalIdentity.id, globalIdentity);
    }

    let repoHostPath: string | null = null;
    if (remoteUrl) {
      try {
        let normalized = remoteUrl.trim();
        if (normalized.startsWith('git@')) {
          normalized = `https://${normalized.slice(4).replace(':', '/')}`;
        }
        if (normalized.endsWith('.git')) {
          normalized = normalized.slice(0, -4);
        }
        const url = new URL(normalized);
        repoHostPath = url.hostname + url.pathname;
      } catch { /* ignore */ }
    }

    for (const profile of profiles) {
      if (profile.authType !== 'token') {
        unique.set(profile.id, profile);
        continue;
      }

      const profileHost = profile.host;
      if (!profileHost) {
        unique.set(profile.id, profile);
        continue;
      }

      if (!profileHost.includes('/')) {
        unique.set(profile.id, profile);
        continue;
      }

      if (repoHostPath && repoHostPath === profileHost) {
        unique.set(profile.id, profile);
      }
    }
    return Array.from(unique.values());
  }, [profiles, globalIdentity, remoteUrl]);

  const activeIdentityProfile = React.useMemo((): GitIdentityProfile | null => {
    if (currentIdentity?.userName && currentIdentity?.userEmail) {
      const match = profiles.find(
        (profile) =>
          profile.userName === currentIdentity.userName &&
          profile.userEmail === currentIdentity.userEmail
      );

      if (match) {
        return match;
      }

      if (
        globalIdentity &&
        globalIdentity.userName === currentIdentity.userName &&
        globalIdentity.userEmail === currentIdentity.userEmail
      ) {
        return globalIdentity;
      }

      return {
        id: 'local-config',
        name: currentIdentity.userName,
        userName: currentIdentity.userName,
        userEmail: currentIdentity.userEmail,
        sshKey: currentIdentity.sshCommand?.replace('ssh -i ', '') ?? null,
        color: 'info',
        icon: 'user',
      };
    }

    return globalIdentity ?? null;
  }, [currentIdentity, profiles, globalIdentity]);

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

  // Clear graph log when directory changes
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

  // Keep these sections stable in layout; individual cards render placeholders when unavailable.

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
        await Promise.all(uniquePaths.map(async (filePath) => {
          try {
            await git.revertGitFile(gitDirectory, filePath, { scope });
          } catch (err) {
            failed.push({
              path: filePath,
              message: err instanceof Error ? err.message : t('gitView.toast.revertFailed'),
            });
          }
        }));

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
    if (gitDirectory && !isMobile) {
      openContextDiff(gitDirectory, path, staged);
      return;
    }
    navigateToDiff(path, staged);
  }, [gitDirectory, isMobile, navigateToDiff, openContextDiff]);

  const openStashes = React.useCallback(() => setIsStashesDialogOpen(true), []);

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
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

  // Helper to add/update operation logs
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

  // Called at start of operation to reset logs
  const resetOperationLogs = React.useCallback(() => {
    setOperationLogs([]);
  }, []);

  // Called when dialog is closed to fully reset state
  const handleOperationComplete = React.useCallback(() => {
    setOperationLogs([]);
    setBranchOperation(null);
  }, []);

  const resolveIntegrationTarget = React.useCallback((branch: string) => {
    const trimmed = branch.trim();
    const knownRemoteNames = new Set(effectiveRemotes.map((remote) => remote.name));
    const slashIndex = trimmed.indexOf('/');

    if (slashIndex > 0) {
      const remote = trimmed.slice(0, slashIndex);
      const remoteBranch = trimmed.slice(slashIndex + 1);
      if (knownRemoteNames.has(remote) && remoteBranch) {
        return { branch: trimmed, remote, remoteBranch };
      }
    }

    for (const remote of effectiveRemotes) {
      const remoteCandidate = `${remote.name}/${trimmed}`;
      if (remoteBranches.includes(remoteCandidate)) {
        return { branch: remoteCandidate, remote: remote.name, remoteBranch: trimmed };
      }
    }

    return { branch: trimmed, remote: null, remoteBranch: null };
  }, [effectiveRemotes, remoteBranches]);

  const handleMerge = React.useCallback(
    async (branch: string) => {
      if (!gitDirectory) return;
      setBranchOperation('merge');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(gitDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Merging ${target.branch} into ${currentBranch}...`, 'running');
        const result = await git.merge(gitDirectory, { branch: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Merge conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(gitDirectory, result.conflictFiles ?? [], 'merge');
        } else {
          updateLastLog('done', `Merged ${target.branch} into ${currentBranch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('merge');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to merge ${target.branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [gitDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleRebase = React.useCallback(
    async (branch: string) => {
      if (!gitDirectory) return;
      setBranchOperation('rebase');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(gitDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Rebasing ${currentBranch} onto ${target.branch}...`, 'running');
        const result = await git.rebase(gitDirectory, { onto: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Rebase conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(gitDirectory, result.conflictFiles ?? [], 'rebase');
        } else {
          updateLastLog('done', `Rebased ${currentBranch} onto ${target.branch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('rebase');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to rebase onto ${target.branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [gitDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleAbortConflict = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      if (conflictOperation === 'merge') {
        await git.abortMerge(gitDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
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

  // Count unresolved conflicts (files with 'U' status)
  const conflictCount = React.useMemo(() => {
    if (!status?.files) return 0;
    return status.files.filter((f) =>
      (f.index === 'U' || f.working_dir === 'U') ||
      (f.index === 'A' && f.working_dir === 'A') ||
      (f.index === 'D' && f.working_dir === 'D')
    ).length;
  }, [status?.files]);

  const handleContinueOperation = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      const isRebase = !!(status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto);

      if (isMerge) {
        const result = await git.continueMerge(gitDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(gitDirectory, result.conflictFiles ?? [], 'merge');
          toast.error(t('gitView.toast.mergeConflictsDetected'));
        } else {
          clearConflictState();
          toast.success(t('gitView.toast.mergeCompleted'));
          await refreshStatusAndBranches();
          await refreshLog();
        }
      } else if (isRebase) {
        const result = await git.continueRebase(gitDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(gitDirectory, result.conflictFiles ?? [], 'rebase');
          toast.error(t('gitView.toast.rebaseConflictsDetected'));
        } else {
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
  }, [gitDirectory, git, status, refreshStatusAndBranches, refreshLog, persistConflictState, clearConflictState, t]);

  const handleAbortOperation = React.useCallback(async () => {
    if (!gitDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      if (isMerge) {
        await git.abortMerge(gitDirectory);
        toast.success(t('gitView.toast.mergeAborted'));
      } else {
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

    // Determine operation type from status
    const isMerge = !!status?.mergeInProgress?.head;
    const operation = isMerge ? 'merge' : 'rebase';

    // Get conflict files from status (files with 'U' status indicate unmerged/conflicted)
    const filesWithConflicts = status?.files
      ?.filter((f) => f.index === 'U' || f.working_dir === 'U')
      .map((f) => f.path) ?? [];

    // Update conflict state and open dialog
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
      const hadStagedChanges = (status?.files ?? []).some(isStagedStatusFile);

      // Stash changes
      try {
        await git.stash(gitDirectory, {
          message: `Auto-stash before ${operation} with ${branch}`,
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
        // Perform the operation
        if (operation === 'merge') {
          const result = await git.merge(gitDirectory, { branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('merge');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.mergedIntoBranch', { branch, currentBranch: currentBranch || '' }));
          }
        } else {
          const result = await git.rebase(gitDirectory, { onto: branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('rebase');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(t('gitView.toast.rebasedOntoBranch', { currentBranch: currentBranch || '', branch }));
          }
        }

        // Restore stashed changes if requested and operation succeeded
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
        // If the operation failed (not due to conflicts), try to restore stash
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
    [bumpIndexRevision, gitDirectory, git, status, stashDialogOperation, stashDialogBranch, refreshStatusAndBranches, refreshLog, t]
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
      // Cherry-pick and revert conflicts are not supported by the shared ConflictDialog
      // Show a toast with manual resolution instructions
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

    setConflictFiles(result.conflictFiles ?? []);
    setConflictOperation(result.operation);
    setConflictDialogOpen(true);
    if (gitDirectory) {
      persistConflictState(gitDirectory, result.conflictFiles ?? [], result.operation);
    }
  }, [t, setConflictFiles, setConflictOperation, setConflictDialogOpen, persistConflictState, gitDirectory, fetchStatus, fetchBranches, fetchLog, logMaxCountLocal, git]);

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          {t('gitView.empty.selectSessionOrDirectory')}
        </p>
      </div>
    );
  }

  if (isGitRepo === null || (isGitRepo === true && !status)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('gitView.loading.checkingRepository')}</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    if (shouldHideNotGitState) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 text-center">
          <Icon name="loader-4" className="mb-3 size-6 animate-spin text-muted-foreground" />
          <p className="typography-ui-label font-semibold text-foreground">
            {t('gitView.empty.worktreeSetupInProgress')}
          </p>
          <p className="typography-meta mt-1 text-muted-foreground">
            {t('gitView.empty.worktreeSetupDescription')}
          </p>
        </div>
      );
    }

    // Nested repository discovery: while unknown or failed keep a loading
    // state with the failure signal; the picker appears once repositories are
    // found (a single repository is auto-selected by an effect above).
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
              onClick={() => {
                if (currentDirectory) {
                  void ensureNestedRepos(currentDirectory, { force: true });
                }
              }}
            >
              <Icon name="refresh" className="size-4" />
              {t('gitView.empty.retryDiscovery')}
            </Button>
          ) : null}
        </div>
      );
    }

    if (nestedRepos.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 text-center">
          <Icon name="git-branch" className="mb-3 size-6 text-muted-foreground" />
          <p className="typography-ui-label font-semibold text-foreground">
            {t('gitView.empty.notGitRepository')}
          </p>
          <p className="typography-meta mt-1 text-muted-foreground">
            {t('gitView.empty.notGitRepositoryDescription')}
          </p>
          {repairActions.includes('open-without-worktree-features') ? (
            <p className="typography-meta mt-2 text-muted-foreground">
              {t('gitView.empty.worktreeFeaturesUnavailable')}
            </p>
          ) : null}
        </div>
      );
    }

    // Repositories were found and are about to be auto-selected (or the
    // selected repository is still probing) — hold a brief loading state.
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <Icon name="loader-4" className="mb-3 size-6 animate-spin text-muted-foreground" />
        <p className="typography-ui-label font-semibold text-foreground">
          {t('gitView.loading.checkingRepository')}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden')}>
          <GitHeader
        status={status}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={branches?.branches}
        syncAction={syncAction}
        remotes={effectiveRemotes}
        onFetch={(remote) => handleSyncAction('fetch', remote)}
        onSync={(remote) => handleSyncAction('sync', remote)}
        onRemoveRemote={handleRemoveRemote}
        removingRemoteName={removingRemoteName}
        onCheckoutBranch={handleCheckoutBranch}
        onCreateBranch={handleCreateBranch}
        onRenameBranch={handleRenameBranch}
        activeIdentityProfile={activeIdentityProfile}
        availableIdentities={availableIdentities}
        onSelectIdentity={handleApplyIdentity}
        isApplyingIdentity={isSettingIdentity}
            isWorktreeMode={!!worktreeMetadata}
            onOpenHistory={() => setGitLogDialogMode('history')}
            onOpenGraph={() => setGitLogDialogMode('graph')}
            onOpenStashes={openStashes}
            onOpenUpdateBranch={canShowBranchWorkflows ? () => setIsUpdateBranchDialogOpen(true) : undefined}
            onOpenReintegrateCommits={integrateCommitsProps ? () => setIsIntegrateCommitsDialogOpen(true) : undefined}
            pullRequest={prChipStatus?.pr ?? null}
            prChecks={prChipStatus?.checks ?? null}
            onOpenPullRequest={
              gitDirectory ? () => openContextSurface(gitDirectory, 'pr') : undefined
            }
            repositoryOptions={gitDirectory !== currentDirectory ? (nestedRepos ?? undefined) : undefined}
            selectedRepository={gitDirectory !== currentDirectory ? gitDirectory : null}
            onSelectRepository={
              gitDirectory !== currentDirectory && currentDirectory
                ? (repository) => selectNestedRepo(currentDirectory, repository)
                : undefined
            }
            repositoryRoot={gitDirectory !== currentDirectory ? currentDirectory : undefined}
          />

      {/* In-progress operation banner */}
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
              as={ScrollShadow}
              ref={actionPanelScrollRef}
              outerClassName="flex-1 min-h-0"
              className={cn('px-4', 'pt-1 pb-4')}
              disableHorizontal
              preventOverscroll
            >
              <div className="flex h-full min-h-0 flex-col gap-3">
                  {(changeEntries?.length ?? 0) > 0 ? (
                    <>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <ChangesPanel
                          groups={changeGroups}
                          diffStats={status?.diffStats}
                          revertingPaths={revertingPaths}
                          isRevertingAll={isRevertingAll}
                          onVisiblePathsChange={setVisibleChangePaths}
                          onRevertAll={handleRevertAll}
                          onRevertDirectory={handleRevertDirectory}
                          headerBackgroundClassName="bg-background"
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
                        onCommit={() => handleCommit({ pushAfter: false })}
                        onCommitAndPush={() => handleCommit({ pushAfter: true })}
                        commitAction={commitAction}
                        hasPendingIndexMutation={hasPendingIndexMutation}
                        gitmojiEnabled={settingsGitmojiEnabled}
                        onOpenGitmojiPicker={() => setIsGitmojiPickerOpen(true)}
                      />
                    </>
                  ) : (
                      <GitEmptyState onOpenStashes={() => setIsStashesDialogOpen(true)} />
                  )}
                </div>
            </ScrollableOverlay>
          </div>
        </div>
      </div>

      <Dialog
        open={isUpdateBranchDialogOpen}
        onOpenChange={(open) => {
          // Keep the dialog up while a merge/rebase is running so the
          // operation log stays visible until it completes or fails.
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
              remoteBranches={remoteBranches}
              defaultTargetBranch={updateTargetBranch}
              onMerge={handleMerge}
              onRebase={handleRebase}
              disabled={isBusy}
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-6 h-7 shrink-0 gap-1.5 px-2"
                onClick={() => {
                  if (gitLogDialogMode === 'graph') {
                    setGraphLogRefreshToken((token) => token + 1);
                    return;
                  }
                  if (!gitDirectory) return;
                  void fetchLog(gitDirectory, git, logMaxCountLocal);
                }}
                disabled={gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading}
                title={t('gitView.history.refresh')}
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
          <Command className="h-[420px]">
            <CommandInput
              placeholder={t('gitView.gitmoji.searchPlaceholder')}
              value={gitmojiSearch}
              onValueChange={setGitmojiSearch}
            />
            <CommandList>
              <CommandEmpty>{t('gitView.gitmoji.empty')}</CommandEmpty>
              <CommandGroup>
                {(gitmojiEmojis.length === 0
                  ? []
                  : gitmojiEmojis.filter((entry) => {
                    const term = gitmojiSearch.trim().toLowerCase();
                    if (!term) return true;
                    return (
                      entry.emoji.includes(term) ||
                      entry.code.toLowerCase().includes(term) ||
                      entry.description.toLowerCase().includes(term)
                    );
                  })
                ).map((entry) => (
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

      <StashDialog
        open={stashDialogOpen}
        onOpenChange={setStashDialogOpen}
        operation={stashDialogOperation}
        targetBranch={stashDialogBranch}
        onConfirm={handleStashAndRetry}
      />

    </div>
  );
};
