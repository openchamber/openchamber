import React from 'react';
import { Icon } from '@/components/icon/Icon';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesPanel, type ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { BranchSelector } from '@/components/views/git/BranchSelector';
import { BranchComparisonSelector } from '@/components/views/git/BranchComparisonSelector';
import { CommitComparisonSelector } from '@/components/views/git/CommitComparisonSelector';
import { branchRefLabel } from '@/components/views/git/baseBranch';
import { isBranchScopeAvailable, isBranchScopeDefinitelyUnavailable, useRangeKeyedCache } from '@/components/views/branchDiffScope';
import { CommitSection } from '@/components/views/git/CommitSection';
import { DirtyBranchSwitchDialog } from '@/components/views/git/DirtyBranchSwitchDialog';
import { SyncActions } from '@/components/views/git/SyncActions';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useBranchComparisonBase } from '@/hooks/useBranchComparisonBase';
import { useCommitComparison } from '@/hooks/useCommitComparison';
import { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import { PullRequestComparisonSelector } from '@/components/views/git/PullRequestComparisonSelector';
import { useGitComparison, type GitComparisonFile, type GitComparisonSource } from '@/hooks/useGitComparison';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { fileDiffFromPatch, isBinaryPatch } from '@/lib/diff/patchFileDiff';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { GitStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { generateCommitMessage, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from '@/lib/gitApi';
import type { GitRemote } from '@/lib/gitApi';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useIsGitRepo,
  useGitLoadingStatus,
} from '@/stores/useGitStore';
import { NestedRepoResolutionStates } from '@/components/views/git/NestedRepoResolutionStates';
import { NestedRepoPicker } from '@/components/views/git/NestedRepoPicker';
import { getRuntimeKey } from '@/lib/runtime-switch';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;

type ChangesMode = 'working' | 'branch' | 'commit' | 'pr';
type ChangesRoute =
  | { type: 'list' }
  | { type: 'diff'; path: string; staged: boolean }
  | { type: 'comparison'; path: string; sourceKey: string };
interface ChangesNavigation {
  ownerKey: string;
  mode: ChangesMode;
  route: ChangesRoute;
}
interface MobileDiffData {
  original: string;
  modified: string;
  isBinary?: boolean;
  fileDiff?: FileDiffMetadata;
}
type ComparisonDiff =
  | { status: 'loading' }
  | { status: 'ready'; diff: MobileDiffData }
  | { status: 'error'; message: string };
const LOADING_COMPARISON_DIFF: ComparisonDiff = { status: 'loading' };
const LIST_ROUTE: ChangesRoute = { type: 'list' };

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

const diffCacheKey = (path: string, staged: boolean): string => staged ? `${path}\u0000staged` : path;

type MobileChangesSurfaceProps = {
  /** When provided, the list header gets a close X that calls this. */
  onClose?: () => void;
  /**
   * A new request object opens its working-tree diff, including repeated requests
   * for the same path. Reopening the drawer keeps the same object and navigation.
   */
  initialDiff?: { path: string; staged: boolean } | null;
  /** The workspace drawer keeps visited panes mounted while hidden. */
  visible?: boolean;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = (props) => {
  const rootDirectory = normalizePath(useEffectiveDirectory() ?? null);
  const repository = useNestedGitDirectory(rootDirectory || null, { enabled: props.visible ?? true });
  return <MobileChangesPane {...props} rootDirectory={rootDirectory} repository={repository} />;
};

interface MobileChangesPaneProps extends MobileChangesSurfaceProps {
  rootDirectory: string;
  repository: ReturnType<typeof useNestedGitDirectory>;
}

/** Repository-scoped navigation and actions, separate from session directory resolution. */
export const MobileChangesPane: React.FC<MobileChangesPaneProps> = ({ rootDirectory, repository, onClose, initialDiff, visible = true }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  // When the root is not itself a repository, changes come from the resolved
  // nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = repository;
  const currentDirectory = gitDirectory ?? rootDirectory;
  const status = useGitStatus(currentDirectory || null);
  const branches = useGitBranches(currentDirectory || null);
  const isGitRepo = useIsGitRepo(currentDirectory || null);
  const isLoadingStatus = useGitLoadingStatus(currentDirectory || null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);
  const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const getDiff = useGitStore((state) => state.getDiff);
  const setDiff = useGitStore((state) => state.setDiff);

  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const ownerKey = JSON.stringify([runtimeKey, currentDirectory]);
  const ownerKeyRef = React.useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [navigation, setNavigation] = React.useState<ChangesNavigation>(() => ({
    ownerKey,
    mode: 'working',
    route: initialDiff?.path ? { type: 'diff', path: initialDiff.path, staged: initialDiff.staged } : LIST_ROUTE,
  }));
  const mode = navigation.ownerKey === ownerKey ? navigation.mode : 'working';
  const route = navigation.ownerKey === ownerKey ? navigation.route : LIST_ROUTE;
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const changeMode = React.useCallback((nextMode: ChangesMode) => {
    setNavigation({ ownerKey, mode: nextMode, route: LIST_ROUTE });
    setModeMenuOpen(false);
  }, [ownerKey]);
  const setRoute = React.useCallback((nextRoute: ChangesRoute) => {
    setNavigation((current) => ({ ownerKey, mode: current.ownerKey === ownerKey ? current.mode : 'working', route: nextRoute }));
  }, [ownerKey]);

  React.useEffect(() => {
    setNavigation((current) => current.ownerKey === ownerKey ? current : { ownerKey, mode: 'working', route: LIST_ROUTE });
    setModeMenuOpen(false);
  }, [ownerKey]);
  React.useEffect(() => { if (!visible) setModeMenuOpen(false); }, [visible]);

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session.
  React.useEffect(() => {
    if (!initialDiff?.path) return;
    // A new external target is a working-tree diff, regardless of the last
    // comparison mode. Changing directories alone must not replay this target.
    setNavigation({ ownerKey: ownerKeyRef.current, mode: 'working', route: { type: 'diff', path: initialDiff.path, staged: initialDiff.staged } });
  }, [initialDiff]);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [commitMessage, setCommitMessage] = React.useState('');
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>([]);
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
  const [pendingDirtySwitchBranch, setPendingDirtySwitchBranch] = React.useState<string | null>(null);

  const currentBranch = status?.current ?? null;
  const trackingRemote = status?.tracking?.trim().split('/')[0];
  const defaultBranch = (trackingRemote && branches?.defaultBranches?.[trackingRemote]) ?? branches?.defaultBranches?.origin ?? null;
  const showBranchOption = isBranchScopeAvailable(currentBranch, defaultBranch);
  const branchUnavailable = isGitRepo === false || isBranchScopeDefinitelyUnavailable(currentBranch, defaultBranch, status !== null, branches !== null);
  const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
  const branchComparison = useBranchComparisonBase(currentDirectory || null, currentBranch, visible && mode === 'branch' && showBranchOption);
  const commitComparison = useCommitComparison(currentDirectory || null, currentBranch, visible && mode === 'commit' && isGitRepo === true);
  const selectedCommitHash = commitComparison.selectedCommit?.hash ?? null;
  const prComparison = usePullRequestComparison(currentDirectory || null, currentBranch, visible && mode === 'pr' && isGitRepo === true);
  const selectedPr = prComparison.selectedSource;
  const comparisonSource = React.useMemo<GitComparisonSource | null>(() => {
    if (mode === 'pr') return selectedPr;
    if (mode === 'branch' && currentBranch && branchComparison.base) return { kind: 'branch', baseRef: branchComparison.base, headRef: currentBranch };
    if (mode === 'commit' && selectedCommitHash) return { kind: 'commit', hash: selectedCommitHash };
    return null;
  }, [branchComparison.base, currentBranch, mode, selectedCommitHash, selectedPr]);
  const comparisonRevision = mode === 'branch' ? branchComparison.revision : '';
  const comparison = useGitComparison(currentDirectory || null, comparisonSource, visible && isGitRepo === true, comparisonRevision);
  const { fetchDiff: loadComparisonDiff } = comparison;
  const comparisonFiles = React.useMemo(() => comparison.files ? [...comparison.files].sort((a, b) => a.path.localeCompare(b.path)) : null, [comparison.files]);
  const activeComparisonPath = route.type === 'comparison' && route.sourceKey === comparison.key ? route.path : null;
  const [comparisonRetry, setComparisonRetry] = React.useState(0);
  const fetchComparisonDiff = React.useCallback(async (path: string): Promise<ComparisonDiff> => {
    try {
      const { diff: patch } = await loadComparisonDiff(path);
      const diff: MobileDiffData = { original: '', modified: '', isBinary: isBinaryPatch(patch) };
      if (!diff.isBinary) diff.fileDiff = fileDiffFromPatch(path, patch);
      return { status: 'ready', diff };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') };
    }
  }, [loadComparisonDiff, t]);
  const comparisonDiffs = useRangeKeyedCache<ComparisonDiff>(
    comparison.files ? (mode === 'pr' ? JSON.stringify([comparison.key, comparison.revision]) : comparison.key) : null,
    visible && activeComparisonPath ? activeComparisonPath : '',
    visible ? fetchComparisonDiff : null,
    LOADING_COMPARISON_DIFF,
    JSON.stringify([comparisonRevision, mode === 'pr' ? comparison.revision : 0, comparisonRetry]),
  );
  const activeComparisonDiff = activeComparisonPath ? comparisonDiffs.get(activeComparisonPath) ?? LOADING_COMPARISON_DIFF : null;

  React.useEffect(() => {
    if (mode === 'branch' && branchUnavailable) changeMode('working');
  }, [branchUnavailable, changeMode, mode]);
  React.useEffect(() => {
    setNavigation((current) => current.ownerKey === ownerKey && current.route.type === 'comparison' && current.route.sourceKey !== comparison.key
      ? { ...current, route: LIST_ROUTE }
      : current);
  }, [comparison.key, ownerKey]);

  const changeEntries = React.useMemo(() => {
    const files = status?.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      unique.set(file.path, file);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status?.files]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries],
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries],
  );

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) return remotes;
    const trackingRemote = status?.tracking?.includes('/') ? status.tracking.split('/')[0] : null;
    if (trackingRemote || remoteUrl) {
      return [{ name: trackingRemote || 'origin', fetchUrl: remoteUrl ?? '', pushUrl: remoteUrl ?? '' }];
    }
    return [];
  }, [remoteUrl, remotes, status?.tracking]);

  const selectedDiff = useGitStore(React.useCallback((state) => {
    if (!currentDirectory || route.type !== 'diff') return null;
    return state.directories.get(currentDirectory)?.diffCache.get(diffCacheKey(route.path, route.staged)) ?? null;
  }, [currentDirectory, route]));

  const selectedFileEntry = React.useMemo(() => {
    if (route.type !== 'diff') return null;
    return changeEntries.find((entry) => entry.path === route.path) ?? null;
  }, [changeEntries, route]);

  const refreshStatusAndBranches = React.useCallback(async (showErrors = true) => {
    if (!currentDirectory) return;
    try {
      await Promise.all([
        fetchStatus(currentDirectory, git),
        fetchBranches(currentDirectory, git),
      ]);
    } catch (error) {
      if (showErrors) {
        toast.error(error instanceof Error ? error.message : t('gitView.toast.refreshRepositoryFailed'));
      }
    }
  }, [currentDirectory, fetchBranches, fetchStatus, git, t]);

  const localBranches = React.useMemo(
    () => (branches?.all ?? []).filter((branch) => !branch.startsWith('remotes/')).sort(),
    [branches],
  );

  const remoteBranches = React.useMemo(
    () => (branches?.all ?? [])
      .filter((branch) => branch.startsWith('remotes/'))
      .map((branch) => branch.replace(/^remotes\//, ''))
      .sort(),
    [branches],
  );

  const performCheckout = React.useCallback(async (branch: string) => {
    if (!currentDirectory) return;
    const normalized = branch.replace(/^remotes\//, '');
    try {
      const result = await git.checkoutBranch(currentDirectory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: result.branch || normalized }));
      await refreshStatusAndBranches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.checkoutFailed', { name: normalized }));
    }
  }, [currentDirectory, git, refreshStatusAndBranches, t]);

  const handleCheckoutBranch = React.useCallback((branch: string) => {
    const normalized = branch.replace(/^remotes\//, '');
    if ((status?.files?.length ?? 0) > 0) {
      setPendingDirtySwitchBranch(normalized);
      return;
    }
    void performCheckout(normalized);
  }, [performCheckout, status?.files]);

  const handleCreateBranch = React.useCallback(async (branch: string, remote?: GitRemote) => {
    if (!currentDirectory) return;
    try {
      await git.createBranch(currentDirectory, branch, currentBranch ?? 'HEAD');
      await git.checkoutBranch(currentDirectory, branch);
      if (remote) {
        await git.gitPush(currentDirectory, { remote: remote.name, branch, options: ['--set-upstream'] });
      }
      await refreshStatusAndBranches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.createBranchFailed'));
      throw error;
    }
  }, [currentBranch, currentDirectory, git, refreshStatusAndBranches, t]);

  const refreshRemotes = React.useCallback(async () => {
    if (!currentDirectory) {
      setRemotes([]);
      setRemoteUrl(null);
      return;
    }
    try {
      const [remoteList, url] = await Promise.all([
        git.getRemotes(currentDirectory).catch(() => []),
        git.getRemoteUrl ? git.getRemoteUrl(currentDirectory).catch(() => null) : Promise.resolve(null),
      ]);
      setRemotes(remoteList);
      setRemoteUrl(url);
    } catch {
      setRemotes([]);
      setRemoteUrl(null);
    }
  }, [currentDirectory, git]);

  React.useEffect(() => {
    if (!currentDirectory || !visible) return;
    setActiveDirectory(currentDirectory);
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git, setActiveDirectory, visible]);

  React.useEffect(() => {
    if (visible) void refreshRemotes();
  }, [refreshRemotes, visible]);

  React.useEffect(() => {
    if (!visible || mode !== 'working' || !currentDirectory || changeEntries.length === 0) return;
    const orderedPaths = Array.from(new Set([
      ...stagedChangeEntries.map((entry) => entry.path),
      ...visibleChangePaths,
      ...changeEntries.slice(0, 20).map((entry) => entry.path),
    ])).filter(Boolean);
    if (orderedPaths.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: 40 });
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [changeEntries, currentDirectory, git, mode, prefetchDiffs, stagedChangeEntries, visibleChangePaths, visible]);

  React.useEffect(() => {
    if (!visible) return;
    if (route.type !== 'diff') {
      setDiffLoadError(null);
      return;
    }
    const cacheKey = diffCacheKey(route.path, route.staged);
    if (!currentDirectory || getDiff(currentDirectory, cacheKey)) {
      setDiffLoadError(null);
      return;
    }

    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    setDiffLoadError(null);
    void git.getGitFileDiff(currentDirectory, { path: route.path, staged: route.staged || undefined })
      .then((response) => {
        if (cancelled) return;
        setDiff(currentDirectory, cacheKey, {
          original: response.original ?? '',
          modified: response.modified ?? '',
          isBinary: response.isBinary,
        }, runtimeKey);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, diffRetryNonce, getDiff, git, route, setDiff, visible]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    setSyncAction(action);
    try {
      const getPullOptions = (pullRemote: GitRemote) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;
        return { remote: pullRemote.name, branch: trackedBranch, rebase: true };
      };

      if (action === 'fetch') {
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        await git.gitFetch(currentDirectory, { remote: remote.name });
        toast.success(t('gitView.toast.fetchedFromRemote', { name: remote.name }));
      } else if (action === 'sync') {
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error(t('gitView.toast.commitOrStashBeforeSync'));
            return;
          }
          await git.gitPull(currentDirectory, getPullOptions(remote));
        }
        const afterPull = await git.getGitStatus(currentDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(currentDirectory);
        }
        toast.success(t('gitView.toast.alreadyUpToDate'));
      }
      await refreshStatusAndBranches(false);
      await refreshRemotes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.syncActionFailed', { action: t('gitView.sync.syncChanges') }));
    } finally {
      setSyncAction(null);
    }
  };

  const moveChangePaths = React.useCallback(async (paths: string[], direction: 'stage' | 'unstage') => {
    if (!currentDirectory || paths.length === 0) return;
    try {
      if (direction === 'stage') {
        if (paths.length > 1) await stageGitFiles(currentDirectory, paths);
        else await stageGitFile(currentDirectory, paths[0]);
      } else {
        if (paths.length > 1) await unstageGitFiles(currentDirectory, paths);
        else await unstageGitFile(currentDirectory, paths[0]);
      }
      await refreshStatusAndBranches(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : direction === 'stage'
        ? t('gitView.toast.stageFileFailed')
        : t('gitView.toast.unstageFileFailed'));
    }
  }, [currentDirectory, refreshStatusAndBranches, t]);

  const handleViewChangeDiff = React.useCallback((path: string, staged = false) => {
    setRoute({ type: 'diff', path, staged });
  }, [setRoute]);

  const handleRevertFile = React.useCallback(async (filePath: string) => {
    if (!currentDirectory) return;
    setRevertingPaths((previous) => new Set(previous).add(filePath));
    try {
      await git.revertGitFile(currentDirectory, filePath);
      toast.success(t('gitView.toast.revertedFile', { path: filePath }));
      await refreshStatusAndBranches(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.revertFailed'));
    } finally {
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.delete(filePath);
        return next;
      });
    }
  }, [currentDirectory, git, refreshStatusAndBranches, t]);

  const handleRevertAll = React.useCallback(async (paths: string[]) => {
    if (!currentDirectory || paths.length === 0 || isRevertingAll) return;
    const uniquePaths = Array.from(new Set(paths));
    setIsRevertingAll(true);
    setRevertingPaths(new Set(uniquePaths));
    try {
      await Promise.all(uniquePaths.map((filePath) => git.revertGitFile(currentDirectory, filePath)));
      await refreshStatusAndBranches(false);
      toast.success(uniquePaths.length === 1
        ? t('gitView.toast.revertedFilesSingle', { count: uniquePaths.length })
        : t('gitView.toast.revertedFilesPlural', { count: uniquePaths.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.revertFailed'));
    } finally {
      setRevertingPaths(new Set());
      setIsRevertingAll(false);
    }
  }, [currentDirectory, git, isRevertingAll, refreshStatusAndBranches, t]);

  const handleInsertHighlights = React.useCallback((highlights: string[]) => {
    const normalized = highlights.map((text) => text.trim()).filter(Boolean);
    if (normalized.length === 0) {
      setGeneratedHighlights([]);
      return;
    }
    setCommitMessage((current) => `${current.trim()}${current.trim() ? '\n\n' : ''}${normalized.join('\n')}`.trim());
    setGeneratedHighlights([]);
  }, []);

  const handleGenerateCommitMessage = React.useCallback(async () => {
    if (!currentDirectory) return;
    const selectedFilePaths = stagedChangeEntries.map((file) => file.path).sort();
    if (selectedFilePaths.length === 0) {
      toast.error(t('gitView.toast.selectFileToDescribe'));
      return;
    }
    setIsGeneratingMessage(true);
    try {
      const { message } = await generateCommitMessage(currentDirectory, selectedFilePaths);
      setCommitMessage(message.subject?.trim() ?? '');
      setGeneratedHighlights(Array.isArray(message.highlights) ? message.highlights : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.generateCommitMessageFailed'));
    } finally {
      setIsGeneratingMessage(false);
    }
  }, [currentDirectory, stagedChangeEntries, t]);

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (!commitMessage.trim()) {
      toast.error(t('gitView.toast.enterCommitMessage'));
      return;
    }
    const filesToCommit = stagedChangeEntries.map((file) => file.path).sort();
    if (filesToCommit.length === 0) {
      toast.error(t('gitView.toast.selectFileToCommit'));
      return;
    }

    setCommitAction(options.pushAfter ? 'commitAndPush' : 'commit');
    try {
      await git.createGitCommit(currentDirectory, commitMessage.trim(), { files: filesToCommit });
      toast.success(t('gitView.toast.commitCreated'));
      setCommitMessage('');
      setGeneratedHighlights([]);

      if (options.pushAfter) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        setSyncAction('sync');
        const trackingPrefix = `${remote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;

        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          await git.gitPull(currentDirectory, { remote: remote.name, branch: trackedBranch, rebase: true });
        }

        const afterPull = await git.getGitStatus(currentDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(currentDirectory);
        }

        await refreshStatusAndBranches(false);
        await refreshRemotes();
      } else {
        await refreshStatusAndBranches(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.createCommitFailed'));
    } finally {
      setCommitAction(null);
      if (options.pushAfter) setSyncAction(null);
    }
  };

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
        actionSymbol: '-',
        actionAllLabel: t('gitView.changes.unstageAllAria'),
        getActionLabel: (path: string) => t('gitView.changes.unstageFileAria', { path }),
        onActionFile: (path: string) => void moveChangePaths([path], 'unstage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'unstage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, true),
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
        getActionLabel: (path: string) => t('gitView.changes.stageFileAria', { path }),
        onActionFile: (path: string) => void moveChangePaths([path], 'stage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'stage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, false),
        onRevertFile: handleRevertFile,
      });
    }

    return groups;
  }, [handleRevertFile, handleViewChangeDiff, moveChangePaths, stagedChangeEntries, t, unstagedChangeEntries]);

  const renderListState = (state: React.ReactNode) => (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory || ''}
          </p>
        </div>
        {rootIsGitRepo === false && Array.isArray(nestedRepos) && nestedRepos.length > 0 ? (
          <NestedRepoPicker
            repositories={nestedRepos}
            selectedRepository={gitDirectory ?? null}
            onSelectRepository={(repository) => {
              if (rootDirectory) selectNestedRepo(rootDirectory, repository);
            }}
            repositoryRoot={rootDirectory ?? undefined}
          />
        ) : null}
      </header>
      <div className="min-h-0 flex-1">{state}</div>
    </div>
  );

  if (!currentDirectory) {
    return renderListState(<MobileChangesState message={t('gitView.empty.selectSessionOrDirectory')} />);
  }

  // Non-repo root: surface nested-repository resolution while the operating
  // directory has not proven to be a repository (discovering, failed,
  // unsupported, none found, or settling on the auto-selected one).
  if (rootIsGitRepo === false && isGitRepo !== true) {
    return renderListState(
      <NestedRepoResolutionStates
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          if (rootDirectory) void ensureNestedRepos(rootDirectory, { force: true });
        }}
      />
    );
  }

  if (isLoadingStatus && isGitRepo === null) {
    return renderListState(<MobileChangesState loading message={t('gitView.loading.checkingRepository')} />);
  }

  if (route.type === 'diff') {
    return (
      <MobileDiffDetail
        path={route.path}
        diff={selectedDiff}
        fileExists={Boolean(selectedFileEntry)}
        error={diffLoadError}
        onBack={() => setRoute({ type: 'list' })}
        onRetry={() => setDiffRetryNonce((value) => value + 1)}
      />
    );
  }

  const modeLabel = mode === 'pr' ? t('session.githubIntegration.tabs.pullRequests') : mode === 'branch' ? t('diffView.scope.branch') : mode === 'commit' ? t('commitComparison.mode') : t('mobile.nav.changes');
  const sourceLabel = mode === 'branch' && branchComparison.base
    ? branchRefLabel(branchComparison.base)
    : mode === 'commit' ? selectedCommitHash?.slice(0, 8) : mode === 'pr' && selectedPr ? `#${selectedPr.number}` : null;
  if (activeComparisonPath && activeComparisonDiff) {
    return (
      <MobileDiffDetail
        path={activeComparisonPath}
        subtitle={[modeLabel, sourceLabel].filter(Boolean).join(' · ')}
        diff={activeComparisonDiff.status === 'ready' ? activeComparisonDiff.diff : null}
        fileExists={!comparison.files || comparison.files.some((file) => file.path === activeComparisonPath)}
        error={comparison.error ?? (activeComparisonDiff.status === 'error' ? activeComparisonDiff.message : null)}
        onBack={() => setRoute(LIST_ROUTE)}
        onRetry={() => {
          if (comparison.error) void comparison.refresh();
          setComparisonRetry((value) => value + 1);
        }}
      />
    );
  }

  const renderComparison = () => {
    if (mode === 'pr' && !selectedPr) return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MobileChangesState loading={prComparison.loading} message={prComparison.error ?? (prComparison.loading
        ? t('session.githubPrPicker.loading.pullRequests') : t('pullRequestComparison.select'))} />
      {!prComparison.loading && <PullRequestComparisonSelector mobile comparison={prComparison} />}
    </div>;
    if (mode === 'branch' && !branchComparison.base) {
      return <MobileChangesState
        loading={!branchComparison.resolved}
        message={branchComparison.resolved ? t('gitView.pr.toast.baseBranchRequired') : t('diffView.branch.resolvingBase')}
      />;
    }
    if (mode === 'commit' && !selectedCommitHash) {
      return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        {commitComparison.loading && <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />}
        <p className="typography-ui-label text-muted-foreground">{commitComparison.loading ? t('diffView.state.loadingChanges') : commitComparison.error ?? t('commitComparison.noCommits')}</p>
        {commitComparison.error && <Button variant="outline" size="lg" onClick={() => void commitComparison.refresh()}>{t('diffView.actions.retry')}</Button>}
      </div>;
    }
    if (comparison.error) {
      return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="typography-ui-label font-semibold">{t('diffView.state.failedToLoadDiff')}</p>
        <p className="typography-meta text-muted-foreground">{comparison.error}</p>
        <Button variant="outline" size="lg" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
      </div>;
    }
    if (!comparisonFiles) return <MobileChangesState loading message={t('diffView.state.loadingChanges')} />;
    if (comparisonFiles.length === 0) {
      return <MobileChangesState icon={mode === 'branch'} message={mode === 'pr' ? t('walkthrough.blocked.emptyDiff.description') : mode === 'commit'
        ? t('commitComparison.emptyDiff')
        : t('diffView.branch.empty', { base: sourceLabel ?? '' })} />;
    }
    return <MobileComparisonFileList files={comparisonFiles} onSelect={(path) => {
      if (comparison.key) setRoute({ type: 'comparison', path, sourceKey: comparison.key });
    }} />;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <DropdownMenu open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={dropdownTriggerVariants({ size: 'default' })} data-mobile-comparison-trigger aria-label={t('diffView.scope.selectorAria')}>
              <span>{modeLabel}</span>
              <Icon name="arrow-down-s" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={mode} onValueChange={(value) => {
              if (value === 'working' || value === 'branch' || value === 'commit' || value === 'pr') changeMode(value);
            }}>
              <DropdownMenuRadioItem value="working" className="min-h-8 items-center">{t('mobile.nav.changes')}</DropdownMenuRadioItem>
              {showBranchOption && <DropdownMenuRadioItem value="branch" className="min-h-8 items-center">{t('diffView.scope.branch')}</DropdownMenuRadioItem>}
              <DropdownMenuRadioItem value="commit" className="min-h-8 items-center">{t('commitComparison.mode')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="pr" className="min-h-8 items-center">{t('session.githubIntegration.tabs.pullRequests')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {visible && mode === 'branch' && (
          <BranchComparisonSelector mobile key={JSON.stringify([ownerKey, currentBranch])}
            branches={branches?.all ?? []} currentBranch={currentBranch} base={branchComparison.base}
            onSelect={(base) => { if (currentBranch) setBaseOverride(currentDirectory, currentBranch, base); }} />
        )}
        {visible && mode === 'commit' && (
          <CommitComparisonSelector mobile key={JSON.stringify([ownerKey, currentBranch])}
            commits={commitComparison.commits} selectedHash={selectedCommitHash}
            loading={commitComparison.loading} error={commitComparison.error}
            onSelect={commitComparison.select} onRefresh={() => void commitComparison.refresh()} />
        )}
        {visible && mode === 'pr' && <>
          <PullRequestComparisonSelector mobile key={JSON.stringify([ownerKey, currentBranch])} comparison={prComparison} />
          {selectedPr && <Button variant="ghost" size="sm" disabled={comparison.loading} aria-label={t('session.githubIssuePicker.actions.refresh')}
            onClick={() => void comparison.refresh()}><Icon name="refresh" className="size-4" /></Button>}
        </>}
      </header>
      {mode === 'working' && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <BranchSelector
              currentBranch={status?.current}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              branchInfo={branches?.branches}
              currentBranchAhead={status?.ahead}
              onCheckout={(branch) => void handleCheckoutBranch(branch)}
              onCreate={handleCreateBranch}
              remotes={effectiveRemotes}
              disabled={isLoadingStatus}
              directory={currentDirectory}
              switchBlockedNotice={(status?.files?.length ?? 0) > 0 ? t('gitView.branch.switchBlockedNotice') : null}
            />
          </div>
          <SyncActions
            syncAction={syncAction}
            remotes={effectiveRemotes}
            onFetch={(remote) => void handleSyncAction('fetch', remote)}
            onSync={(remote) => void handleSyncAction('sync', remote)}
            disabled={commitAction !== null || isLoadingStatus}
            aheadCount={status?.ahead ?? 0}
            behindCount={status?.behind ?? 0}
            trackingRemoteName={status?.tracking?.split('/')[0]}
            hasUncommittedChanges={changeEntries.length > 0}
          />
        </div>
      )}
      {mode !== 'working' ? (
        <div className="min-h-0 flex-1">{renderComparison()}</div>
      ) : changeEntries.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* File list scrolls inside ChangesPanel; the commit footer stays pinned. */}
          <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
            <ChangesPanel
              groups={changeGroups}
              diffStats={status?.diffStats}
              revertingPaths={revertingPaths}
              onRevertAll={handleRevertAll}
              isRevertingAll={isRevertingAll}
              headerBackgroundClassName="bg-transparent"
              onVisiblePathsChange={setVisibleChangePaths}
            />
          </div>
          <div className="shrink-0 border-t border-border/70 px-4 pb-4 pt-3">
            <CommitSection
              stagedCount={stagedChangeEntries.length}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              generatedHighlights={generatedHighlights}
              onInsertHighlights={handleInsertHighlights}
              onGenerateMessage={handleGenerateCommitMessage}
              isGeneratingMessage={isGeneratingMessage}
              onCommit={() => void handleCommit({ pushAfter: false })}
              onCommitAndPush={() => void handleCommit({ pushAfter: true })}
              commitAction={commitAction}
              gitmojiEnabled={false}
              onOpenGitmojiPicker={() => {}}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MobileChangesState icon message={t('gitView.empty.cleanTitle')} description={t('mobile.changes.cleanDescription')} />
        </div>
      )}
      <DirtyBranchSwitchDialog
        open={pendingDirtySwitchBranch !== null}
        onOpenChange={(open) => { if (!open) setPendingDirtySwitchBranch(null); }}
        targetBranch={pendingDirtySwitchBranch ?? ''}
        changedFileCount={status?.files?.length ?? 0}
        onCommitAndSwitch={async (message, pushAfter) => {
          const branch = pendingDirtySwitchBranch;
          if (!branch || !currentDirectory) return;
          const sourceBranch = status?.current ?? null;
          await git.createGitCommit(currentDirectory, message, { addAll: true });
          let pushedRemoteName: string | null = null;
          if (pushAfter) {
            const trackingRemoteName = status?.tracking?.split('/')[0];
            const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
            try {
              if (!remote) throw new Error(t('mobile.changes.noRemote'));
              await git.gitPush(currentDirectory, status?.tracking
                ? { remote: remote.name }
                : { remote: remote.name, branch: sourceBranch ?? undefined, options: ['--set-upstream'] });
              pushedRemoteName = remote.name;
            } catch {
              toast.error(t('gitView.dirtySwitch.pushFailed'));
              await refreshStatusAndBranches();
              setPendingDirtySwitchBranch(null);
              return;
            }
          }
          toast.success(sourceBranch
            ? pushedRemoteName
              ? t('gitView.toast.pushedToUpstream', { name: pushedRemoteName })
              : t('gitView.dirtySwitch.committedNotPushed', { branch: sourceBranch })
            : t('gitView.toast.commitCreated'));
          await refreshStatusAndBranches();
          setPendingDirtySwitchBranch(null);
          await performCheckout(branch);
        }}
        onGenerateMessage={async () => {
          if (!currentDirectory) return '';
          const paths = (status?.files ?? []).map((file) => file.path).sort();
          const { message } = await generateCommitMessage(currentDirectory, paths);
          return message.subject?.trim() ?? '';
        }}
        onRevertAndSwitch={async () => {
          const branch = pendingDirtySwitchBranch;
          if (!branch || !currentDirectory) return;
          await handleRevertAll((status?.files ?? []).map((file) => file.path));
          const fresh = await git.getGitStatus(currentDirectory);
          if (!fresh.isClean && (fresh.files?.length ?? 0) > 0) {
            toast.error(t('gitView.dirtySwitch.revertIncomplete'));
            return;
          }
          setPendingDirtySwitchBranch(null);
          await performCheckout(branch);
        }}
      />
    </div>
  );
};

const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

const MobileDiffDetail: React.FC<{
  path: string;
  subtitle?: string;
  diff: MobileDiffData | null;
  fileExists: boolean;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}> = ({ path, subtitle, diff, fileExists, error, onBack, onRetry }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/70 px-3 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="truncate typography-ui-header text-foreground">{path}</h2>
          {subtitle && <p className="truncate typography-meta text-muted-foreground">{subtitle}</p>}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.missingTitle')} description={t('mobile.changes.diffDetail.missingDescription')} />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{t('mobile.changes.diffDetail.loadFailed')}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('diffView.actions.retry')}</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : diff.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : isImageFile(path) && !diff.fileDiff ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.imageUnavailable')} />
        ) : (
          <ScrollShadow
            className="h-full overflow-y-auto overflow-x-hidden p-3"
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              fileDiff={diff.fileDiff}
              language={language}
              fileName={path}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
            />
          </ScrollShadow>
        )}
      </div>
    </div>
  );
};

const MobileComparisonFileList: React.FC<{ files: GitComparisonFile[]; onSelect: (path: string) => void }> = ({ files, onSelect }) => {
  const { t } = useI18n();
  return (
    <ScrollShadow className="h-full overflow-y-auto overflow-x-hidden px-3 py-2">
      <ul aria-label={t('gitView.changes.changedFilesAria')} className="flex flex-col gap-1">
        {files.map((file) => {
          const statusLabel = file.status === 'A' ? t('diffView.change.new')
            : file.status === 'D' ? t('diffView.change.deleted')
            : file.status === 'R' ? t('diffView.change.renamed')
            : file.status === 'C' ? t('diffView.change.copied') : t('diffView.change.modified');
          const statusColor = file.status === 'A' ? 'var(--status-success)' : file.status === 'D' ? 'var(--status-error)'
            : file.status === 'R' || file.status === 'C' ? 'var(--status-info)' : 'var(--status-warning)';
          return <li key={file.path}>
            <Button variant="ghost" size="lg" className="w-full justify-start gap-2.5 text-left normal-case" onClick={() => onSelect(file.path)}>
              <span className="w-4 shrink-0 text-center typography-meta font-semibold uppercase" style={{ color: statusColor }} aria-label={statusLabel}>{file.status}</span>
              <FileTypeIcon filePath={file.path} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label" title={file.path}>{file.path}</span>
              {(file.insertions > 0 || file.deletions > 0) && <span className="shrink-0 typography-meta text-muted-foreground">+{file.insertions} -{file.deletions}</span>}
              <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </li>;
        })}
      </ul>
    </ScrollShadow>
  );
};
