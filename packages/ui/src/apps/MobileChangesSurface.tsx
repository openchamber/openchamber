import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesPanel, type ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { BranchSelector } from '@/components/views/git/BranchSelector';
import { CommitSection } from '@/components/views/git/CommitSection';
import { DirtyBranchSwitchDialog } from '@/components/views/git/DirtyBranchSwitchDialog';
import { SyncActions } from '@/components/views/git/SyncActions';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useMobileBranchDiffScope, type UseMobileBranchDiffScopeResult } from '@/hooks/useMobileBranchDiffScope';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import type { GitStatus } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
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
import { cn } from '@/lib/utils';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;

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
   * When set (and non-null), the surface opens directly into the per-file diff view for this
   * relative path. Updating it (incl. setting it to a different path while open) routes the
   * surface to that diff. Setting it back to null leaves the user on the current internal route.
   */
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = ({ onClose, initialDiffPath, initialDiffStaged = false }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const rootDirectory = normalizePath(useEffectiveDirectory() ?? null);
  // When the root is not itself a repository, changes come from the resolved
  // nested repository instead.
  const { rootIsGitRepo, gitDirectory, nestedRepos } = useNestedGitDirectory(rootDirectory || null);
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

  const [route, setRoute] = React.useState<{ type: 'list' } | { type: 'diff'; path: string; staged: boolean }>(
    () => (initialDiffPath ? { type: 'diff', path: initialDiffPath, staged: initialDiffStaged } : { type: 'list' }),
  );

  // Picks the data source: the working tree (staged/unstaged + commit/sync) or
  // the current branch's range diff against its base. `route` stays the
  // list-vs-detail navigation; a scope switch always lands on the new scope's
  // list, and a stale branch diff must never survive a scope switch or a
  // confirmed-unavailable branch scope (see the coercion effect below).
  const [scope, setScope] = React.useState<'changes' | 'branch'>('changes');

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session. A pushed diff is always a working-tree diff.
  React.useEffect(() => {
    if (!initialDiffPath) return;
    setScope('changes');
    setRoute((current) => (
      current.type === 'diff' && current.path === initialDiffPath && current.staged === initialDiffStaged
        ? current
        : { type: 'diff', path: initialDiffPath, staged: initialDiffStaged }
    ));
  }, [initialDiffPath, initialDiffStaged]);

  const branchScope = useMobileBranchDiffScope({
    directory: currentDirectory,
    currentBranch: status?.current ?? null,
    trackingRemote: status?.tracking ?? null,
    isGitRepo,
    isBranchStatusResolved: status !== null,
    isEnabled: scope === 'branch',
    activePath: scope === 'branch' && route.type === 'diff' ? route.path : null,
  });

  // Coercion only ever rewrites a CONFIRMED-unavailable branch scope; while
  // metadata is still loading the persisted scope survives (the hook treats
  // "default branch unknown" as not-yet-known, not unavailable). Rendering
  // follows effectiveScope, so the frame already shows the Changes list; the
  // effect then aligns the persisted state (scope + any stale diff route) in
  // one commit so a branch diff can never survive the coercion.
  const effectiveScope = scope === 'branch' && branchScope.branchScopeDefinitelyUnavailable ? 'changes' : scope;

  React.useEffect(() => {
    if (effectiveScope !== scope) {
      setScope('changes');
      setRoute({ type: 'list' });
    }
  }, [effectiveScope, scope]);

  const handleScopeChange = React.useCallback((next: 'changes' | 'branch') => {
    if (next === scope) return;
    setScope(next);
    setRoute({ type: 'list' });
  }, [scope]);

  const handleViewBranchDiff = React.useCallback((path: string) => {
    setRoute({ type: 'diff', path, staged: false });
  }, []);
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
      await git.createBranch(currentDirectory, branch, status?.current ?? 'HEAD');
      await git.checkoutBranch(currentDirectory, branch);
      if (remote) {
        await git.gitPush(currentDirectory, { remote: remote.name, branch, options: ['--set-upstream'] });
      }
      await refreshStatusAndBranches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.createBranchFailed'));
      throw error;
    }
  }, [currentDirectory, git, refreshStatusAndBranches, status?.current, t]);

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
    if (!currentDirectory) return;
    setActiveDirectory(currentDirectory);
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git, setActiveDirectory]);

  React.useEffect(() => {
    void refreshRemotes();
  }, [refreshRemotes]);

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) return;
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
  }, [changeEntries, currentDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  React.useEffect(() => {
    if (route.type !== 'diff' || scope === 'branch') {
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
  }, [currentDirectory, diffRetryNonce, getDiff, git, route, scope, setDiff]);

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
  }, []);

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

  if (route.type === 'diff' && scope === effectiveScope) {
    // The scope check guards the one-render window where a confirmed-
    // unavailable branch scope has not been rewritten by the coercion effect
    // yet: a branch diff must never render a working-tree frame, and vice
    // versa. It falls through to the (Changes) list below instead.
    if (effectiveScope === 'branch') {
      return (
        <MobileBranchDiffDetail
          path={route.path}
          branchScope={branchScope}
          onBack={() => setRoute({ type: 'list' })}
        />
      );
    }
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

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/70 px-3 text-foreground">
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
        <MobileScopeSelector
          scope={effectiveScope}
          showBranchOption={branchScope.isBranchScopeAvailable}
          onScopeChange={handleScopeChange}
        />
      </header>
      {effectiveScope === 'changes' ? (
        <div className="flex shrink-0 justify-center border-b border-border/70 px-3 py-2">
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
      ) : null}
      {effectiveScope === 'branch' ? (
        <MobileBranchFileList branchScope={branchScope} onSelectFile={handleViewBranchDiff} />
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
  diff: { original: string; modified: string; isBinary?: boolean } | null;
  fileExists: boolean;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}> = ({ path, diff, fileExists, error, onBack, onRetry }) => {
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
        ) : isImageFile(path) ? (
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

/**
 * The "Changed" vs "Branch" mode switch for the mobile changes list. It lives
 * in the header's right side, beside the title, so the scope is always visible
 * without a dedicated row. The pill gives both segments 40px+ touch targets.
 * The Branch segment only appears once the default branch is known and differs
 * from the current one; while it is absent the control degrades to a single
 * active segment instead of disappearing, so the header layout never shifts.
 */
const MobileScopeSelector: React.FC<{
  scope: 'changes' | 'branch';
  showBranchOption: boolean;
  onScopeChange: (scope: 'changes' | 'branch') => void;
}> = ({ scope, showBranchOption, onScopeChange }) => {
  const { t } = useI18n();

  const renderSegment = (value: 'changes' | 'branch', label: string, icon?: 'git-branch') => {
    const isActive = scope === value;
    return (
      <button
        type="button"
        aria-pressed={isActive}
        onClick={() => onScopeChange(value)}
        className={cn(
          'flex h-10 min-w-16 items-center justify-center gap-1.5 rounded-lg px-3 typography-ui-label font-medium transition-colors',
          isActive
            ? 'bg-interactive-selection text-interactive-selection-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
        )}
        style={{ touchAction: 'manipulation' }}
      >
        {icon ? <Icon name={icon} className="size-4" /> : null}
        {label}
      </button>
    );
  };

  return (
    <div
      role="group"
      aria-label={t('diffView.scope.selectorAria')}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-0.5"
    >
      {renderSegment('changes', t('diffView.scope.changed'))}
      {showBranchOption ? renderSegment('branch', t('diffView.scope.branch'), 'git-branch') : null}
    </div>
  );
};

// Mirrors the desktop DiffView CHANGE_DESCRIPTORS colors for the range status
// letters (A/M/D/R/C). The letter keeps the desktop's semantic color; the
// label is localized. Unknown statuses read as modified, like the desktop's
// default descriptor.
type BranchChangeDescriptor = { code: string; color: string; labelKey: I18nKey };

const describeBranchChange = (status: string): BranchChangeDescriptor => {
  switch (status) {
    case 'A':
      return { code: 'A', color: 'var(--status-success)', labelKey: 'diffView.change.new' };
    case 'M':
      return { code: 'M', color: 'var(--status-warning)', labelKey: 'diffView.change.modified' };
    case 'D':
      return { code: 'D', color: 'var(--status-error)', labelKey: 'diffView.change.deleted' };
    case 'R':
      return { code: 'R', color: 'var(--status-info)', labelKey: 'diffView.change.renamed' };
    case 'C':
      return { code: 'C', color: 'var(--status-info)', labelKey: 'diffView.change.copied' };
    default:
      return { code: 'M', color: 'var(--status-warning)', labelKey: 'diffView.change.modified' };
  }
};

/**
 * The branch scope's list body, in desktop-mirroring priority order: base
 * resolution spinner, base picker (search + candidates), branch-files error
 * with retry, in-flight files spinner, empty state, then the read-only file
 * list. Tapping a row opens the branch diff detail for that path.
 *
 * Once a base is resolved the list carries a pinned base row at the top; it is
 * the always-visible entry into the change-base picker, including while the
 * list is empty, errored, or reloading. Picking a new base must not flash the
 * previous base's file list under the new base row, so the picker hand-off
 * holds a local in-flight flag until the hook's range reload lands.
 */
const MobileBranchFileList: React.FC<{
  branchScope: UseMobileBranchDiffScopeResult;
  onSelectFile: (path: string) => void;
}> = ({ branchScope, onSelectFile }) => {
  const { t } = useI18n();
  const [isBasePickerOpen, setIsBasePickerOpen] = React.useState(false);
  // Holds the file-list area on the loading state between picking a new base
  // and the hook publishing the new range's files. Without it one render would
  // show the new base row above the previous base's file list.
  const [baseChangeInFlight, setBaseChangeInFlight] = React.useState(false);
  const sawRangeReloadRef = React.useRef(false);

  // The hook clears and reloads branchFiles in an effect that runs AFTER this
  // child's effect in the pick commit, so "files became non-null" alone cannot
  // end the hold: the first non-null read is still the OLD base's list. Only a
  // reload pass (files === null) proves the new range replaced it. An error
  // also ends the hold; the error frame renders above the loading state.
  React.useEffect(() => {
    if (!baseChangeInFlight) {
      sawRangeReloadRef.current = false;
      return;
    }
    if (branchScope.branchFilesError) {
      setBaseChangeInFlight(false);
      return;
    }
    if (branchScope.branchFiles === null) {
      sawRangeReloadRef.current = true;
      return;
    }
    if (sawRangeReloadRef.current) {
      setBaseChangeInFlight(false);
    }
  }, [baseChangeInFlight, branchScope.branchFiles, branchScope.branchFilesError]);

  const handlePickBase = (branch: string) => {
    const changed = branch !== branchScope.branchBase;
    branchScope.setBaseOverride(branch);
    setIsBasePickerOpen(false);
    // Picking the current base keeps the list untouched; only a real change
    // needs the loading hold.
    if (changed) setBaseChangeInFlight(true);
  };

  // Every state fills the remaining body space below the header and the scope
  // selector; `h-full` content inside a `min-h-0 flex-1` wrapper keeps the
  // centering inside the visible body instead of the whole surface.
  if (!branchScope.isBranchBaseResolved) {
    return (
      <div className="min-h-0 flex-1">
        <MobileChangesState loading message={t('diffView.branch.resolvingBase')} />
      </div>
    );
  }

  const branchBase = branchScope.branchBase;
  if (!branchBase) {
    // No base at all: the fallback picker (no "current base" to return to).
    return (
      <div className="min-h-0 flex-1">
        <MobileBranchBasePicker branchScope={branchScope} onPick={handlePickBase} />
      </div>
    );
  }

  if (isBasePickerOpen) {
    return (
      <div className="min-h-0 flex-1">
        <MobileBranchBasePicker
          branchScope={branchScope}
          onPick={handlePickBase}
          onClose={() => setIsBasePickerOpen(false)}
        />
      </div>
    );
  }

  const showLoading = baseChangeInFlight || branchScope.branchFiles === null;

  const branchFiles = branchScope.branchFiles;
  let content: React.ReactNode;
  if (branchScope.branchFilesError) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.loadError')}</p>
        <p className="max-w-sm typography-meta text-muted-foreground">{branchScope.branchFilesError}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => branchScope.reloadBranchFiles()}>
          {t('diffView.actions.retry')}
        </Button>
      </div>
    );
  } else if (showLoading) {
    content = <MobileChangesState loading message={t('diffView.branch.loadingFiles')} />;
  } else if (branchFiles && branchFiles.length === 0) {
    content = <MobileChangesState icon message={t('diffView.branch.empty', { base: branchBase })} />;
  } else {
    const sortedFiles = [...(branchFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    content = (
      <ScrollShadow className="h-full overflow-y-auto overflow-x-hidden px-3 py-2">
        <ul role="list" aria-label={t('gitView.changes.changedFilesAria')} className="flex flex-col gap-1">
          {sortedFiles.map((file) => {
            const descriptor = describeBranchChange(file.status);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onSelectFile(file.path)}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  style={{ touchAction: 'manipulation' }}
                >
                  <span
                    className="typography-micro w-4 shrink-0 text-center font-semibold uppercase"
                    style={{ color: descriptor.color }}
                    aria-label={t(descriptor.labelKey)}
                    title={t(descriptor.labelKey)}
                  >
                    {descriptor.code}
                  </span>
                  <FileTypeIcon filePath={file.path} className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={file.path}>
                    {file.path}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollShadow>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MobileBranchBaseRow branchBase={branchBase} onPress={() => setIsBasePickerOpen(true)} />
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
};

/**
 * The pinned "current base" row above the branch file list. Tapping it opens
 * the change-base picker. Shown for every resolved-base state (list, empty,
 * error, reloading) so the base stays visible and changeable even with no
 * changes on the branch.
 */
const MobileBranchBaseRow: React.FC<{
  branchBase: string;
  onPress: () => void;
}> = ({ branchBase, onPress }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-10 w-full shrink-0 items-center gap-2 border-b border-border/60 bg-[var(--surface-elevated)]/40 px-4 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="git-branch" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
        {t('gitView.pr.field.baseBranch')}: {branchBase}
      </span>
      <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
};

/**
 * The base-branch picker. Two modes share the search + candidate list:
 * - fallback (no `onClose`): git could not detect where the current branch
 *   started; shows the no-base title/description, and the whole body is the
 *   picker.
 * - change (with `onClose`): a base is already resolved; shows a back row
 *   labelled with the current base so the user knows what they are replacing.
 * Picking any branch writes the override through the hook, which the surface
 * never reads back directly — the hook resolves it into branchBase.
 */
const MobileBranchBasePicker: React.FC<{
  branchScope: UseMobileBranchDiffScopeResult;
  onPick: (branch: string) => void;
  onClose?: () => void;
}> = ({ branchScope, onPick, onClose }) => {
  const { t } = useI18n();
  const [searchTerm, setSearchTerm] = React.useState('');
  const normalizedTerm = searchTerm.trim().toLowerCase();
  const candidates = branchScope.candidateBranches.filter(
    (branch) => !normalizedTerm || branch.toLowerCase().includes(normalizedTerm),
  );

  return (
    <ScrollShadow className="h-full overflow-y-auto">
      <div className="flex flex-col gap-3 px-4 py-4">
        {onClose ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('header.actions.backAria')}
            >
              <Icon name="arrow-left" className="size-5" />
            </button>
            <h3 className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
              {t('gitView.pr.field.baseBranch')}: {branchScope.branchBase ?? ''}
            </h3>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 text-center">
            <Icon name="git-branch" className="size-6 text-muted-foreground" />
            <h3 className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.noBaseTitle')}</h3>
            <p className="max-w-sm typography-micro text-muted-foreground">{t('diffView.branch.noBaseDescription')}</p>
          </div>
        )}
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t('gitView.branch.searchPlaceholder')}
            aria-label={t('gitView.branch.searchPlaceholder')}
            className="h-10 w-full rounded-md border border-border/60 bg-[var(--surface-elevated)] pl-9 pr-3 typography-ui-label text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          />
        </div>
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-center typography-meta text-muted-foreground">{t('gitView.branch.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {candidates.map((branch) => (
              <li key={branch}>
                <button
                  type="button"
                  onClick={() => onPick(branch)}
                  className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="git-branch" className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={branch}>
                    {branch}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScrollShadow>
  );
};

/**
 * The branch scope's per-file diff detail. Mirrors the working-tree
 * MobileDiffDetail chrome (back button, scrolling wrapper) but renders from
 * the hook's range-keyed cache instead of the working-tree diff cache: the
 * diff is resolved per requested path, so this view is always a fresh fetch
 * for the branch range (see the hook's activeFileDiff state machine).
 */
const MobileBranchDiffDetail: React.FC<{
  path: string;
  branchScope: UseMobileBranchDiffScopeResult;
  onBack: () => void;
}> = ({ path, branchScope, onBack }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);
  const fileDiffStatus = branchScope.activeFileDiff;

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
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {fileDiffStatus.status === 'idle' || fileDiffStatus.status === 'loading' ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : fileDiffStatus.value.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : fileDiffStatus.value.fileDiff ? (
          <ScrollShadow
            className="h-full overflow-y-auto overflow-x-hidden p-3"
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original=""
              modified=""
              fileDiff={fileDiffStatus.value.fileDiff}
              language={language}
              fileName={path}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
            />
          </ScrollShadow>
        ) : (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        )}
      </div>
    </div>
  );
};
