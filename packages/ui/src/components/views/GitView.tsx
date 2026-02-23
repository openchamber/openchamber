import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import type { GitIdentityProfile, CommitFileEntry } from '@/lib/api/types';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useGitIdentity,
  useIsGitRepo,
} from '@/stores/useGitStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import {
  RiGitBranchLine,
  RiGitMergeLine,
  RiGitCommitLine,
  RiGitPullRequestLine,
  RiLoader4Line,
  RiSplitCellsHorizontal,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { AnimatedTabs } from '@/components/ui/animated-tabs';
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

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { IntegrateCommitsSection } from './git/IntegrateCommitsSection';

import { GitHeader } from './git/GitHeader';
import { ChangesSection } from './git/ChangesSection';
import { CommitSection } from './git/CommitSection';
import { GitEmptyState } from './git/GitEmptyState';
import { HistorySection } from './git/HistorySection';
import { PullRequestSection } from './git/PullRequestSection';
import { ConflictDialog } from './git/ConflictDialog';
import { StashDialog } from './git/StashDialog';
import { InProgressOperationBanner } from './git/InProgressOperationBanner';
import { BranchIntegrationSection, type OperationLogEntry } from './git/BranchIntegrationSection';
import type { GitRemote } from '@/lib/gitApi';
import { BranchPickerDialog } from '@/components/session/BranchPickerDialog';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { cn } from '@/lib/utils';

type SyncAction = 'fetch' | 'pull' | 'push' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;
type BranchOperation = 'merge' | 'rebase' | null;
type ActionTab = 'commit' | 'branch' | 'pr' | 'worktree';

const GIT_ACTION_TAB_STORAGE_KEY = 'oc.git.actionTab';

const isActionTab = (value: unknown): value is ActionTab =>
  value === 'commit' || value === 'branch' || value === 'pr' || value === 'worktree';


type GitViewSnapshot = {
  directory?: string;
  selectedPaths: string[];
  commitMessage: string;
  generatedHighlights: string[];
};

type GitmojiEntry = {
  emoji: string;
  code: string;
  description: string;
};

type GitmojiCachePayload = {
  gitmojis: GitmojiEntry[];
  fetchedAt: number;
  version: string;
};

const GITMOJI_CACHE_KEY = 'gitmojiCache';
const GITMOJI_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GITMOJI_CACHE_VERSION = '1';
const GITMOJI_SOURCE_URL =
  'https://raw.githubusercontent.com/carloscuesta/gitmoji/master/packages/gitmojis/src/gitmojis.json';

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

const isGitmojiEntry = (value: unknown): value is GitmojiEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.emoji === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.description === 'string'
  );
};

const readGitmojiCache = (): GitmojiCachePayload | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(GITMOJI_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GitmojiCachePayload>;
    if (!parsed || parsed.version !== GITMOJI_CACHE_VERSION || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    if (!Array.isArray(parsed.gitmojis)) return null;
    const gitmojis = parsed.gitmojis.filter(isGitmojiEntry);
    return { gitmojis, fetchedAt: parsed.fetchedAt, version: parsed.version };
  } catch {
    return null;
  }
};

const writeGitmojiCache = (gitmojis: GitmojiEntry[]) => {
  if (typeof window === 'undefined') return;
  try {
    const payload: GitmojiCachePayload = {
      gitmojis,
      fetchedAt: Date.now(),
      version: GITMOJI_CACHE_VERSION,
    };
    localStorage.setItem(GITMOJI_CACHE_KEY, JSON.stringify(payload));
  } catch {
    return;
  }
};

const isGitmojiCacheFresh = (payload: GitmojiCachePayload) =>
  Date.now() - payload.fetchedAt < GITMOJI_CACHE_TTL_MS;

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

const gitViewSnapshots = new Map<string, GitViewSnapshot>();

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

interface GitViewProps {
  mode?: 'full' | 'sidebar';
}

export const GitView: React.FC<GitViewProps> = ({ mode = 'full' }) => {
  const { git } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const { currentSessionId, worktreeMetadata: worktreeMap } = useSessionStore();
  const worktreeMetadata = currentSessionId
    ? worktreeMap.get(currentSessionId) ?? undefined
    : undefined;


  const { profiles, globalIdentity, defaultGitIdentityId, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId } =
    useGitIdentitiesStore();

  const isGitRepo = useIsGitRepo(currentDirectory ?? null);
  const status = useGitStatus(currentDirectory ?? null);
  const branches = useGitBranches(currentDirectory ?? null);
  const log = useGitLog(currentDirectory ?? null);
  const currentIdentity = useGitIdentity(currentDirectory ?? null);
  const isLoading = useGitStore((state) => state.isLoadingStatus);
  const isLogLoading = useGitStore((state) => state.isLoadingLog);
  const {
    setActiveDirectory,
    fetchAll,
    fetchStatus,
    fetchBranches,
    fetchLog,
    fetchIdentity,
    setLogMaxCount,
  } = useGitStore();

  const initialSnapshot = React.useMemo(() => {
    if (!currentDirectory) return null;
    return gitViewSnapshots.get(currentDirectory) ?? null;
  }, [currentDirectory]);

  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const [isBranchPickerOpen, setIsBranchPickerOpen] = React.useState(false);
  const [rootBranchHint, setRootBranchHint] = React.useState<string | null>(null);

  React.useEffect(() => {
    const projectRoot = worktreeMetadata?.projectDirectory;
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
  }, [worktreeMetadata?.projectDirectory]);

  const branchPickerProject = React.useMemo(() => {
    const current = normalizePath(currentDirectory);
    const worktreeRoot = normalizePath(worktreeMetadata?.projectDirectory);
    const best = projects
      .map((project) => ({
        id: project.id,
        path: project.path,
        label: project.label,
        normalizedPath: normalizePath(project.path),
      }))
      .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)
      .find((project) => {
        if (!project.normalizedPath) return false;
        if (worktreeRoot && project.normalizedPath === worktreeRoot) return true;
        return current === project.normalizedPath || current.startsWith(`${project.normalizedPath}/`);
      });

    return best ?? null;
  }, [currentDirectory, projects, worktreeMetadata?.projectDirectory]);

  const [commitMessage, setCommitMessage] = React.useState(
    initialSnapshot?.commitMessage ?? ''
  );
  const [isGitmojiPickerOpen, setIsGitmojiPickerOpen] = React.useState(false);
  const actionPanelScrollRef = React.useRef<HTMLElement | null>(null);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [logMaxCountLocal, setLogMaxCountLocal] = React.useState<number>(25);
  const [isSettingIdentity, setIsSettingIdentity] = React.useState(false);
  const { triggerFireworks } = useFireworksCelebration();
  const isSidebarMode = mode === 'sidebar';

  const autoAppliedDefaultRef = React.useRef<Map<string, string>>(new Map());
  const identityApplyCountRef = React.useRef(0);

  const beginIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current += 1;
    setIsSettingIdentity(true);
  }, []);

  const endIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current = Math.max(0, identityApplyCountRef.current - 1);
    if (identityApplyCountRef.current === 0) {
      setIsSettingIdentity(false);
    }
  }, []);

  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(
    () => new Set(initialSnapshot?.selectedPaths ?? [])
  );
  const [hasUserAdjustedSelection, setHasUserAdjustedSelection] = React.useState(false);
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [integrateRefreshKey, setIntegrateRefreshKey] = React.useState(0);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>(
    initialSnapshot?.generatedHighlights ?? []
  );

  const scrollActionPanelToBottom = React.useCallback(() => {
    const scrollTarget = actionPanelScrollRef.current;
    if (!scrollTarget) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
      });
    });
  }, []);

  const repoRootForIntegrate = worktreeMetadata?.projectDirectory || null;
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
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [gitmojiEmojis, setGitmojiEmojis] = React.useState<GitmojiEntry[]>([]);
  const [gitmojiSearch, setGitmojiSearch] = React.useState('');
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = React.useState(false);
  const [actionTab, setActionTab] = React.useState<ActionTab>(() => {
    if (typeof window === 'undefined') {
      return 'commit';
    }
    const stored = window.localStorage.getItem(GIT_ACTION_TAB_STORAGE_KEY);
    return isActionTab(stored) ? stored : 'commit';
  });
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [branchOperation, setBranchOperation] = React.useState<BranchOperation>(null);
  const [operationLogs, setOperationLogs] = React.useState<OperationLogEntry[]>([]);
  const [conflictDialogOpen, setConflictDialogOpen] = React.useState(false);
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([]);
  const [conflictOperation, setConflictOperation] = React.useState<'merge' | 'rebase'>('merge');

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

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(GIT_ACTION_TAB_STORAGE_KEY, actionTab);
  }, [actionTab]);

  // Restore conflict state from localStorage on mount
  React.useEffect(() => {
    if (!conflictStorageKey || typeof window === 'undefined' || !currentDirectory) return;

    const raw = window.localStorage.getItem(conflictStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        directory: string;
        conflictFiles: string[];
        operation: 'merge' | 'rebase';
      };

      // Validate the stored state matches current directory
      if (parsed.directory !== currentDirectory) {
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
  }, [conflictStorageKey, currentDirectory]);
  const [stashDialogOpen, setStashDialogOpen] = React.useState(false);
  const [stashDialogOperation, setStashDialogOperation] = React.useState<'merge' | 'rebase'>('merge');
  const [stashDialogBranch, setStashDialogBranch] = React.useState('');

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success('Commit hash copied');
        return;
      }
      toast.error('Failed to copy');
    });
  }, []);

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
    if (!currentDirectory || !git) return;

    // Find hashes that are expanded but not yet loaded or loading
    const hashesToLoad = Array.from(expandedCommitHashes).filter(
      (hash) => !commitFilesMap.has(hash) && !loadingCommitHashes.has(hash)
    );

    if (hashesToLoad.length === 0) return;

    setLoadingCommitHashes((prev) => {
      const next = new Set(prev);
      for (const hash of hashesToLoad) {
        next.add(hash);
      }
      return next;
    });

    for (const hash of hashesToLoad) {
      git
        .getCommitFiles(currentDirectory, hash)
        .then((response) => {
          setCommitFilesMap((prev) => new Map(prev).set(hash, response.files));
        })
        .catch((error) => {
          console.error('Failed to fetch commit files:', error);
          setCommitFilesMap((prev) => new Map(prev).set(hash, []));
        })
        .finally(() => {
          setLoadingCommitHashes((prev) => {
            const next = new Set(prev);
            next.delete(hash);
            return next;
          });
        });
    }
  }, [expandedCommitHashes, currentDirectory, git, commitFilesMap, loadingCommitHashes]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    gitViewSnapshots.set(currentDirectory, {
      directory: currentDirectory,
      selectedPaths: Array.from(selectedPaths),
      commitMessage,
      generatedHighlights,
    });
  }, [commitMessage, currentDirectory, selectedPaths, generatedHighlights]);

  React.useEffect(() => {
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  React.useEffect(() => {
    if (!currentDirectory || !git?.getRemoteUrl) {
      setRemoteUrl(null);
      return;
    }
    git.getRemoteUrl(currentDirectory).then(setRemoteUrl).catch(() => setRemoteUrl(null));
  }, [currentDirectory, git]);

  React.useEffect(() => {
    if (!currentDirectory || !git?.getRemotes) {
      setRemotes([]);
      return;
    }
    git.getRemotes(currentDirectory).then(setRemotes).catch(() => setRemotes([]));
  }, [currentDirectory, git]);

  React.useEffect(() => {
    if (!settingsGitmojiEnabled) {
      setGitmojiEmojis([]);
      return;
    }

    let cancelled = false;

    const cached = readGitmojiCache();
    if (cached) {
      setGitmojiEmojis(cached.gitmojis);
      if (isGitmojiCacheFresh(cached)) {
        return () => {
          cancelled = true;
        };
      }
    }

    const loadGitmojis = async () => {
      try {
        const response = await fetch(GITMOJI_SOURCE_URL);
        if (!response.ok) {
          throw new Error(`Failed to load gitmojis: ${response.statusText}`);
        }
        const payload = (await response.json()) as { gitmojis?: GitmojiEntry[] };
        const gitmojis = Array.isArray(payload.gitmojis) ? payload.gitmojis.filter(isGitmojiEntry) : [];
        if (!cancelled) {
          setGitmojiEmojis(gitmojis);
          writeGitmojiCache(gitmojis);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load gitmoji list:', error);
        }
      }
    };

    void loadGitmojis();

    return () => {
      cancelled = true;
    };
  }, [settingsGitmojiEnabled]);

  React.useEffect(() => {
    if (currentDirectory) {
      setActiveDirectory(currentDirectory);

      const dirState = useGitStore.getState().directories.get(currentDirectory);
      if (!dirState?.status) {
        fetchAll(currentDirectory, git, { force: true });
      }
    }
  }, [currentDirectory, setActiveDirectory, fetchAll, git]);

  const refreshStatusAndBranches = React.useCallback(
    async (showErrors = true) => {
      if (!currentDirectory) return;

      try {
        await Promise.all([
          fetchStatus(currentDirectory, git),
          fetchBranches(currentDirectory, git),
        ]);
      } catch (err) {
        if (showErrors) {
          const message =
            err instanceof Error ? err.message : 'Failed to refresh repository state';
          toast.error(message);
        }
      }
    },
    [currentDirectory, git, fetchStatus, fetchBranches]
  );

  const refreshLog = React.useCallback(async () => {
    if (!currentDirectory) return;
    await fetchLog(currentDirectory, git, logMaxCountLocal);
  }, [currentDirectory, git, fetchLog, logMaxCountLocal]);

  const refreshIdentity = React.useCallback(async () => {
    if (!currentDirectory) return;
    await fetchIdentity(currentDirectory, git);
  }, [currentDirectory, git, fetchIdentity]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    if (!git?.hasLocalIdentity) return;
    if (isGitRepo !== true) return;

    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (!defaultId || defaultId === 'global') return;

    const previousAttempt = autoAppliedDefaultRef.current.get(currentDirectory);
    if (previousAttempt === defaultId) return;

    let cancelled = false;

    const run = async () => {
      try {
        const hasLocal = await git.hasLocalIdentity?.(currentDirectory);
        if (cancelled) return;
        if (hasLocal === true) return;

        beginIdentityApply();
        await git.setGitIdentity(currentDirectory, defaultId);
        autoAppliedDefaultRef.current.set(currentDirectory, defaultId);
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
  }, [beginIdentityApply, currentDirectory, defaultGitIdentityId, endIdentityApply, git, isGitRepo, refreshIdentity]);

  const changeEntries = React.useMemo(() => {
    if (!status) return [];
    const files = status.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();

    for (const file of files) {
      unique.set(file.path, file);
    }

    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);


  React.useEffect(() => {
    if (!status || changeEntries.length === 0) {
      setSelectedPaths(new Set());
      setHasUserAdjustedSelection(false);
      return;
    }

    setSelectedPaths((previous) => {
      const next = new Set<string>();
      const previousSet = previous ?? new Set<string>();

      for (const file of changeEntries) {
        if (previousSet.has(file.path)) {
          next.add(file.path);
        } else if (!hasUserAdjustedSelection) {
          next.add(file.path);
        }
      }

      return next;
    });
  }, [status, changeEntries, hasUserAdjustedSelection]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    setSyncAction(action);

    try {
      if (action === 'fetch') {
        if (!remote) {
          throw new Error('No remote available for fetch');
        }
        await git.gitFetch(currentDirectory, { remote: remote.name });
        toast.success(`Fetched from ${remote.name}`);
      } else if (action === 'pull') {
        if (!remote) {
          throw new Error('No remote available for pull');
        }
        const result = await git.gitPull(currentDirectory, { remote: remote.name });
        toast.success(
          `Pulled ${result.files.length} file${result.files.length === 1 ? '' : 's'} from ${remote.name}`
        );
      } else if (action === 'push') {
        await git.gitPush(currentDirectory);
        toast.success('Pushed to upstream');
      }

      await refreshStatusAndBranches(false);
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to ${action === 'pull' ? 'pull' : action}`;
      toast.error(message);
    } finally {
      setSyncAction(null);
    }
  };

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (!commitMessage.trim()) {
      toast.error('Please enter a commit message');
      return;
    }

    const filesToCommit = Array.from(selectedPaths).sort();
    if (filesToCommit.length === 0) {
      toast.error('Select at least one file to commit');
      return;
    }

    const action: CommitAction = options.pushAfter ? 'commitAndPush' : 'commit';
    setCommitAction(action);

    try {
      await git.createGitCommit(currentDirectory, commitMessage.trim(), {
        files: filesToCommit,
      });
      toast.success('Commit created successfully');
      setCommitMessage('');
      setSelectedPaths(new Set());
      setHasUserAdjustedSelection(false);
      clearGeneratedHighlights();

      await refreshStatusAndBranches();

      if (options.pushAfter) {
        await git.gitPush(currentDirectory);
        toast.success('Pushed to upstream');
        triggerFireworks();
        await refreshStatusAndBranches(false);
      } else {
        await refreshStatusAndBranches(false);
      }

      await refreshLog();
      setIntegrateRefreshKey((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create commit';
      toast.error(message);
    } finally {
      setCommitAction(null);
    }
  };

  const handleGenerateCommitMessage = React.useCallback(async () => {
    if (!currentDirectory) return;
    if (selectedPaths.size === 0) {
      toast.error('Select at least one file to describe');
      return;
    }

    setIsGeneratingMessage(true);
    try {
      const { getResolvedGitGenerationModel, settingsZenModel } = useConfigStore.getState();
      const resolvedModel = getResolvedGitGenerationModel();
      const options: { zenModel?: string; providerId?: string; modelId?: string } = {};
      if (resolvedModel) {
        options.providerId = resolvedModel.providerId;
        options.modelId = resolvedModel.modelId;
        if (resolvedModel.providerId === 'zen') {
          options.zenModel = resolvedModel.modelId;
        }
      } else if (settingsZenModel) {
        options.zenModel = settingsZenModel;
      }
      const { message } = await git.generateCommitMessage(
        currentDirectory,
        Array.from(selectedPaths),
        Object.keys(options).length > 0 ? options : undefined
      );
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
      const message =
        error instanceof Error ? error.message : 'Failed to generate commit message';
      toast.error(message);
    } finally {
      setIsGeneratingMessage(false);
    }
  }, [currentDirectory, selectedPaths, git, settingsGitmojiEnabled, gitmojiEmojis, scrollActionPanelToBottom]);

  const handleCreateBranch = async (branchName: string, remote?: GitRemote) => {
    if (!currentDirectory || !status) return;
    const checkoutBase = status.current ?? null;
    const remoteName = remote?.name ?? 'origin';

    try {
      await git.createBranch(currentDirectory, branchName, checkoutBase ?? 'HEAD');
      toast.success(`Created branch ${branchName}`);

      // Checkout the new branch and stay on it
      await git.checkoutBranch(currentDirectory, branchName);

      let pushSucceeded = false;
      try {
        await git.gitPush(currentDirectory, {
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
        toast.warning('Branch created locally', {
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
        toast.success(`Upstream set for ${branchName} on ${remoteName}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch';
      toast.error(message);
      throw err;
    }
  };

  const handleRenameBranch = async (oldName: string, newName: string) => {
    if (!currentDirectory) return;

    try {
      await git.renameBranch(currentDirectory, oldName, newName);
      toast.success(`Renamed branch ${oldName} to ${newName}`);
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to rename branch ${oldName} to ${newName}`;
      toast.error(message);
    }
  };

  const handleCheckoutBranch = async (branch: string) => {
    if (!currentDirectory) return;
    const normalized = branch.replace(/^remotes\//, '');

    if (status?.current === normalized) {
      return;
    }

    try {
      await git.checkoutBranch(currentDirectory, normalized);
      toast.success(`Checked out ${normalized}`);
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to checkout ${normalized}`;
      toast.error(message);
    }
  };

  const handleApplyIdentity = async (profile: GitIdentityProfile) => {
    if (!currentDirectory) return;
    beginIdentityApply();

    try {
      await git.setGitIdentity(currentDirectory, profile.id);
      toast.success(`Applied "${profile.name}" to repository`);
      await refreshIdentity();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply git identity';
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

  const baseBranch = React.useMemo(() => {
    const remoteNames = new Set(effectiveRemotes.map((remote) => remote.name));
    const normalizeBaseCandidate = (value: string): string => {
      if (!value) {
        return '';
      }

      let normalized = value.trim();
      if (!normalized || normalized === 'HEAD') {
        return '';
      }

      if (localBranches.includes(normalized)) {
        return normalized;
      }

      if (normalized.startsWith('refs/heads/')) {
        normalized = normalized.slice('refs/heads/'.length);
      }
      if (normalized.startsWith('heads/')) {
        normalized = normalized.slice('heads/'.length);
      }
      if (normalized.startsWith('remotes/')) {
        normalized = normalized.slice('remotes/'.length);
      }

      const slashIndex = normalized.indexOf('/');
      if (slashIndex > 0) {
        const maybeRemote = normalized.slice(0, slashIndex);
        if (remoteNames.has(maybeRemote)) {
          const withoutRemote = normalized.slice(slashIndex + 1).trim();
          if (withoutRemote) {
            normalized = withoutRemote;
          }
        }
      }

      return normalized;
    };

    const fromMeta = normalizeBaseCandidate(
      typeof worktreeMetadata?.createdFromBranch === 'string' ? worktreeMetadata.createdFromBranch : ''
    );
    if (fromMeta) return fromMeta;

    const fromHint = normalizeBaseCandidate(typeof rootBranchHint === 'string' ? rootBranchHint : '');
    if (fromHint) return fromHint;

    if (localBranches.includes('main')) return 'main';
    if (localBranches.includes('master')) return 'master';
    if (localBranches.includes('develop')) return 'develop';
    return 'main';
  }, [effectiveRemotes, localBranches, rootBranchHint, worktreeMetadata?.createdFromBranch]);

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

  const selectedCount = selectedPaths.size;
  const isBusy = isLoading || syncAction !== null || commitAction !== null;
  const canShowIntegrateCommitsSection = Boolean(
    worktreeMetadata && repoRootForIntegrate && sourceBranchForIntegrate && shouldShowIntegrateCommits
  );
  const canShowPullRequestSection = Boolean(
    currentDirectory && status?.current && status?.tracking && status.current !== baseBranch
  );
  const canShowBranchWorkflows = Boolean(status?.current);
  const integrateCommitsProps =
    canShowIntegrateCommitsSection && repoRootForIntegrate && sourceBranchForIntegrate && worktreeMetadata
      ? {
          repoRoot: repoRootForIntegrate,
          sourceBranch: sourceBranchForIntegrate,
          worktreeMetadata,
        }
      : null;
  const pullRequestProps =
    canShowPullRequestSection && currentDirectory && status?.current
      ? {
          directory: currentDirectory,
          branch: status.current,
        }
      : null;
  // Keep these sections stable in layout; individual cards render placeholders when unavailable.

  const toggleFileSelection = (path: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    setHasUserAdjustedSelection(true);
  };

  const selectAll = () => {
    const next = new Set(changeEntries.map((file) => file.path));
    setSelectedPaths(next);
    setHasUserAdjustedSelection(true);
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
    setHasUserAdjustedSelection(true);
  };

  const handleRevertFile = React.useCallback(
    async (filePath: string) => {
      if (!currentDirectory) return;

      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.revertGitFile(currentDirectory, filePath);
        toast.success(`Reverted ${filePath}`);
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to revert changes';
        toast.error(message);
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [currentDirectory, refreshStatusAndBranches, git]
  );

  const handleInsertHighlights = React.useCallback(() => {
    if (generatedHighlights.length === 0) return;
    const normalizedHighlights = generatedHighlights
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
  }, [generatedHighlights, clearGeneratedHighlights]);

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

  const handleLogMaxCountChange = React.useCallback(
    (count: number) => {
      setLogMaxCountLocal(count);
      if (currentDirectory) {
        setLogMaxCount(currentDirectory, count);
        fetchLog(currentDirectory, git, count);
      }
    },
    [currentDirectory, setLogMaxCount, fetchLog, git]
  );

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

  const handleMerge = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('merge');
      resetOperationLogs();

      const currentBranch = status?.current;

      try {
        // If it's a remote branch (contains '/'), fetch latest first
        const slashIndex = branch.indexOf('/');
        if (slashIndex > 0) {
          const remote = branch.substring(0, slashIndex);
          const remoteBranch = branch.substring(slashIndex + 1);
          addOperationLog(`Fetching ${remote}/${remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote, branch: remoteBranch });
          updateLastLog('done', `Fetched ${remote}/${remoteBranch}`);
        }

        addOperationLog(`Merging ${branch} into ${currentBranch}...`, 'running');
        const result = await git.merge(currentDirectory, { branch });

        if (result.conflict) {
          updateLastLog('error', `Merge conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
        } else {
          updateLastLog('done', `Merged ${branch} into ${currentBranch}`);
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
          setStashDialogBranch(branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to merge ${branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleRebase = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('rebase');
      resetOperationLogs();

      const currentBranch = status?.current;

      try {
        // If it's a remote branch (contains '/'), fetch latest first
        const slashIndex = branch.indexOf('/');
        if (slashIndex > 0) {
          const remote = branch.substring(0, slashIndex);
          const remoteBranch = branch.substring(slashIndex + 1);
          addOperationLog(`Fetching ${remote}/${remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote, branch: remoteBranch });
          updateLastLog('done', `Fetched ${remote}/${remoteBranch}`);
        }

        addOperationLog(`Rebasing ${currentBranch} onto ${branch}...`, 'running');
        const result = await git.rebase(currentDirectory, { onto: branch });

        if (result.conflict) {
          updateLastLog('error', `Rebase conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
        } else {
          updateLastLog('done', `Rebased ${currentBranch} onto ${branch}`);
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
          setStashDialogBranch(branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to rebase onto ${branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleAbortConflict = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      if (conflictOperation === 'merge') {
        await git.abortMerge(currentDirectory);
        toast.success('Merge aborted');
      } else {
        await git.abortRebase(currentDirectory);
        toast.success('Rebase aborted');
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to abort ${conflictOperation}`;
      toast.error(message);
    }
  }, [currentDirectory, git, conflictOperation, refreshStatusAndBranches, refreshLog, clearConflictState]);

  // Check if there are unresolved conflicts (files with 'U' status)
  const hasUnresolvedConflicts = React.useMemo(() => {
    if (!status?.files) return false;
    return status.files.some((f) =>
      (f.index === 'U' || f.working_dir === 'U') ||
      (f.index === 'A' && f.working_dir === 'A') ||
      (f.index === 'D' && f.working_dir === 'D')
    );
  }, [status?.files]);

  const handleContinueOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      const isRebase = !!(status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto);

      if (isMerge) {
        const result = await git.continueMerge(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
          toast.error('Merge conflicts detected');
        } else {
          clearConflictState();
          toast.success('Merge completed');
          await refreshStatusAndBranches();
          await refreshLog();
        }
      } else if (isRebase) {
        const result = await git.continueRebase(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
          toast.error('Rebase conflicts detected');
        } else {
          clearConflictState();
          toast.success('Rebase step completed');
          await refreshStatusAndBranches();
          await refreshLog();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to continue operation';
      toast.error(message);
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, persistConflictState, clearConflictState]);

  const handleAbortOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      if (isMerge) {
        await git.abortMerge(currentDirectory);
        toast.success('Merge aborted');
      } else {
        await git.abortRebase(currentDirectory);
        toast.success('Rebase aborted');
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to abort operation';
      toast.error(message);
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, clearConflictState]);

  const handleResolveWithAIFromBanner = React.useCallback(() => {
    if (!currentDirectory) return;

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
  }, [currentDirectory, status]);

  const handleStashAndRetry = React.useCallback(
    async (restoreAfter: boolean) => {
      if (!currentDirectory) return;

      const currentBranch = status?.current;
      const operation = stashDialogOperation;
      const branch = stashDialogBranch;

      // Stash changes
      try {
        await git.stash(currentDirectory, {
          message: `Auto-stash before ${operation} with ${branch}`,
          includeUntracked: true,
        });
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
          const result = await git.merge(currentDirectory, { branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('merge');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(`Merged ${branch} into ${currentBranch}`);
          }
        } else {
          const result = await git.rebase(currentDirectory, { onto: branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('rebase');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(`Rebased ${currentBranch} onto ${branch}`);
          }
        }

        // Restore stashed changes if requested and operation succeeded
        if (restoreAfter && operationSucceeded) {
          try {
            await git.stashPop(currentDirectory);
            toast.success('Stashed changes restored');
          } catch (popErr) {
            const popMessage = popErr instanceof Error ? popErr.message : 'Failed to restore stashed changes';
            toast.error(popMessage);
          }
        } else if (restoreAfter && hasConflict) {
          toast.info('Stashed changes will need to be restored manually after resolving conflicts');
        }

        await refreshStatusAndBranches();
        await refreshLog();
      } catch (err) {
        // If the operation failed (not due to conflicts), try to restore stash
        if (restoreAfter) {
          try {
            await git.stashPop(currentDirectory);
          } catch {
            // Ignore stash pop errors in this case
          }
        }
        throw err;
      }
    },
    [currentDirectory, git, status, stashDialogOperation, stashDialogBranch, refreshStatusAndBranches, refreshLog]
  );

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          Select a session or directory to view repository details.
        </p>
      </div>
    );
  }

  if (isLoading && isGitRepo === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RiLoader4Line className="size-4 animate-spin" />
          <span className="typography-ui-label">Checking repository...</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center">
        <RiGitBranchLine className="mb-3 size-6 text-muted-foreground" />
        <p className="typography-ui-label font-semibold text-foreground">
          Not a Git repository
        </p>
        <p className="typography-meta mt-1 text-muted-foreground">
          Choose a different directory or initialize Git to use this workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" data-keyboard-avoid="true">
      <GitHeader
        status={status}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={branches?.branches}
        syncAction={syncAction}
        remotes={effectiveRemotes}
        onFetch={(remote) => handleSyncAction('fetch', remote)}
        onPull={(remote) => handleSyncAction('pull', remote)}
        onPush={() => handleSyncAction('push')}
        onCheckoutBranch={handleCheckoutBranch}
        onCreateBranch={handleCreateBranch}
        onRenameBranch={handleRenameBranch}
        activeIdentityProfile={activeIdentityProfile}
        availableIdentities={availableIdentities}
        onSelectIdentity={handleApplyIdentity}
        isApplyingIdentity={isSettingIdentity}
        isWorktreeMode={!!worktreeMetadata}
        isSidebarMode={isSidebarMode}
        onOpenHistory={() => setIsHistoryDialogOpen(true)}
        onOpenBranchPicker={!isSidebarMode && branchPickerProject ? () => setIsBranchPickerOpen(true) : undefined}
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
            hasUnresolvedConflicts={hasUnresolvedConflicts}
            isLoading={isLoading}
          />
        )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className={cn('min-w-0 min-h-0 h-full bg-muted/10 flex flex-col', isSidebarMode && 'border-t border-border/40')}>
            <div className="px-3 py-1.5">
              <AnimatedTabs<ActionTab>
                value={actionTab}
                onValueChange={setActionTab}
                size="sm"
                collapseLabelsOnSmall
                collapseLabelsOnNarrow={isSidebarMode}
                tabs={[
                  { value: 'commit', label: 'Commit', icon: RiGitCommitLine },
                  { value: 'branch', label: 'Update', icon: RiGitMergeLine },
                  { value: 'pr', label: 'PR', icon: RiGitPullRequestLine },
                  { value: 'worktree', label: 'Worktree', icon: RiSplitCellsHorizontal },
                ]}
              />
            </div>
            <div className="h-px bg-border/40" />

            <ScrollableOverlay
              as={ScrollShadow}
              ref={actionPanelScrollRef}
              outerClassName="flex-1 min-h-0"
              className="px-4 py-4"
              disableHorizontal
              preventOverscroll
            >
              {actionTab === 'commit' ? (
                <div className="space-y-4">
                  {(changeEntries?.length ?? 0) > 0 ? (
                    <>
                      <ChangesSection
                        variant="plain"
                        maxListHeightClassName="max-h-[40vh]"
                        changeEntries={changeEntries}
                        selectedPaths={selectedPaths}
                        diffStats={status?.diffStats}
                        revertingPaths={revertingPaths}
                        onToggleFile={toggleFileSelection}
                        onSelectAll={selectAll}
                        onClearSelection={clearSelection}
                        onViewDiff={(path) => {
                          if (isSidebarMode && currentDirectory) {
                            useUIStore.getState().openContextDiff(currentDirectory, path);
                            return;
                          }
                          useUIStore.getState().navigateToDiff(path);
                        }}
                        onRevertFile={handleRevertFile}
                      />

                      <CommitSection
                        variant="plain"
                        selectedCount={selectedCount}
                        commitMessage={commitMessage}
                        onCommitMessageChange={setCommitMessage}
                        generatedHighlights={generatedHighlights}
                        onInsertHighlights={handleInsertHighlights}
                        onClearHighlights={clearGeneratedHighlights}
                        onGenerateMessage={handleGenerateCommitMessage}
                        isGeneratingMessage={isGeneratingMessage}
                        onCommit={() => handleCommit({ pushAfter: false })}
                        onCommitAndPush={() => handleCommit({ pushAfter: true })}
                        commitAction={commitAction}
                        isBusy={isBusy}
                        gitmojiEnabled={settingsGitmojiEnabled}
                        onOpenGitmojiPicker={() => setIsGitmojiPickerOpen(true)}
                      />
                    </>
                  ) : (
                    <GitEmptyState
                      behind={effectiveRemotes.length > 0 ? (status?.behind ?? 0) : 0}
                      isPulling={syncAction === 'pull'}
                      onPull={() => {
                        const remote = effectiveRemotes[0];
                        if (!remote) {
                          return;
                        }
                        void handleSyncAction('pull', remote);
                      }}
                    />
                  )}
                </div>
              ) : null}

              {actionTab === 'branch' ? (
                <div className="space-y-4">
                  {canShowBranchWorkflows ? (
                    <BranchIntegrationSection
                      mode="inline"
                      currentBranch={status?.current}
                      localBranches={localBranches}
                      remoteBranches={remoteBranches}
                      onMerge={handleMerge}
                      onRebase={handleRebase}
                      disabled={isBusy}
                      isOperating={branchOperation !== null}
                      operationLogs={operationLogs}
                      onOperationComplete={handleOperationComplete}
                    />
                  ) : (
                    <p className="typography-meta text-muted-foreground">Branch actions unavailable.</p>
                  )}
                </div>
              ) : null}

              {actionTab === 'worktree' ? (
                integrateCommitsProps ? (
                  <IntegrateCommitsSection
                    variant="plain"
                    repoRoot={integrateCommitsProps.repoRoot}
                    sourceBranch={integrateCommitsProps.sourceBranch}
                    worktreeMetadata={integrateCommitsProps.worktreeMetadata}
                    localBranches={localBranches}
                    defaultTargetBranch={defaultTargetBranch}
                    refreshKey={integrateRefreshKey}
                    onRefresh={() => {
                      if (!currentDirectory) return;
                      fetchStatus(currentDirectory, git);
                      fetchBranches(currentDirectory, git);
                      fetchLog(currentDirectory, git, logMaxCountLocal);
                    }}
                  />
                ) : (
                  <div className="space-y-1">
                    <div className="typography-ui-header font-semibold text-foreground">Re-integrate commits</div>
                    <div className="typography-micro text-muted-foreground">
                      Available in worktree mode.
                    </div>
                  </div>
                )
              ) : null}

              {actionTab === 'pr' ? (
                pullRequestProps ? (
                  <PullRequestSection
                    variant="plain"
                    directory={pullRequestProps.directory}
                    branch={pullRequestProps.branch}
                    baseBranch={baseBranch}
                    trackingBranch={status?.tracking ?? undefined}
                    remotes={remotes}
                    remoteBranches={remoteBranches}
                    onGeneratedDescription={scrollActionPanelToBottom}
                  />
                ) : (
                  <div className="space-y-1">
                    <div className="typography-ui-header font-semibold text-foreground">Pull Request</div>
                    <div className="typography-micro text-muted-foreground">
                      Push a non-base branch (with upstream) to create a PR.
                    </div>
                  </div>
                )
              ) : null}
            </ScrollableOverlay>
          </div>
        </div>
      </div>

      <Dialog open={isHistoryDialogOpen} onOpenChange={setIsHistoryDialogOpen}>
        <DialogContent className="max-w-5xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>History</DialogTitle>
            <DialogDescription>
              Browse recent commits and inspect file-level changes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <HistorySection
              log={log}
              isLogLoading={isLogLoading}
              logMaxCount={logMaxCountLocal}
              onLogMaxCountChange={handleLogMaxCountChange}
              expandedCommitHashes={expandedCommitHashes}
              onToggleCommit={handleToggleCommit}
              commitFilesMap={commitFilesMap}
              loadingCommitHashes={loadingCommitHashes}
              onCopyHash={handleCopyCommitHash}
              showHeader={false}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isGitmojiPickerOpen} onOpenChange={setIsGitmojiPickerOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Pick a gitmoji</DialogTitle>
          </DialogHeader>
          <Command className="h-[420px]">
            <CommandInput
              placeholder="Search gitmojis..."
              value={gitmojiSearch}
              onValueChange={setGitmojiSearch}
            />
            <CommandList>
              <CommandEmpty>No gitmojis found.</CommandEmpty>
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

      {currentDirectory && (
        <ConflictDialog
          open={conflictDialogOpen}
          onOpenChange={setConflictDialogOpen}
          conflictFiles={conflictFiles}
          directory={currentDirectory}
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

      <BranchPickerDialog
        open={isBranchPickerOpen}
        onOpenChange={setIsBranchPickerOpen}
        project={branchPickerProject}
      />

    </div>
  );
};
