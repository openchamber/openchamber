import React from 'react';
import { RiArrowLeftLine, RiCloseLine, RiGitBranchLine, RiLoader4Line } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesSection } from '@/components/views/git/ChangesSection';
import { CommitSection } from '@/components/views/git/CommitSection';
import { SyncActions } from '@/components/views/git/SyncActions';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { generateCommitMessage } from '@/lib/gitApi';
import type { GitRemote } from '@/lib/gitApi';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import {
  useGitStore,
  useGitStatus,
  useIsGitRepo,
  useGitLoadingStatus,
} from '@/stores/useGitStore';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

type MobileChangesSurfaceProps = {
  /** When provided, the list header gets a close X that calls this; used when the surface is hosted in MobileSurfaceShell. */
  onClose?: () => void;
  /**
   * When set (and non-null), the surface opens directly into the per-file diff view for this
   * relative path. Updating it (incl. setting it to a different path while open) routes the
   * surface to that diff. Setting it back to null leaves the user on the current internal route.
   */
  initialDiffPath?: string | null;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = ({ onClose, initialDiffPath }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const currentDirectory = normalizePath(useEffectiveDirectory() ?? null);
  const status = useGitStatus(currentDirectory || null);
  const isGitRepo = useIsGitRepo(currentDirectory || null);
  const isLoadingStatus = useGitLoadingStatus(currentDirectory || null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const getDiff = useGitStore((state) => state.getDiff);
  const setDiff = useGitStore((state) => state.setDiff);

  const [route, setRoute] = React.useState<{ type: 'list' } | { type: 'diff'; path: string }>(
    () => (initialDiffPath ? { type: 'diff', path: initialDiffPath } : { type: 'list' }),
  );

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session.
  React.useEffect(() => {
    if (!initialDiffPath) return;
    setRoute((current) => (current.type === 'diff' && current.path === initialDiffPath ? current : { type: 'diff', path: initialDiffPath }));
  }, [initialDiffPath]);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [commitMessage, setCommitMessage] = React.useState('');
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());
  const [hasUserAdjustedSelection, setHasUserAdjustedSelection] = React.useState(false);
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>([]);
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);

  const changeEntries = React.useMemo(() => {
    const files = status?.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      unique.set(file.path, file);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status?.files]);

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
    return state.directories.get(currentDirectory)?.diffCache.get(route.path) ?? null;
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
    if (!status || changeEntries.length === 0) {
      setSelectedPaths(new Set());
      setHasUserAdjustedSelection(false);
      return;
    }

    setSelectedPaths((previous) => {
      const next = new Set<string>();
      for (const file of changeEntries) {
        if (previous.has(file.path) || !hasUserAdjustedSelection) {
          next.add(file.path);
        }
      }
      return next;
    });
  }, [changeEntries, hasUserAdjustedSelection, status]);

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) return;
    const orderedPaths = Array.from(new Set([
      ...selectedPaths,
      ...visibleChangePaths,
      ...changeEntries.slice(0, 20).map((entry) => entry.path),
    ])).filter(Boolean);
    if (orderedPaths.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: 40 });
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [changeEntries, currentDirectory, git, prefetchDiffs, selectedPaths, visibleChangePaths]);

  React.useEffect(() => {
    if (route.type !== 'diff') {
      setDiffLoadError(null);
      return;
    }
    if (!currentDirectory || getDiff(currentDirectory, route.path)) {
      setDiffLoadError(null);
      return;
    }

    let cancelled = false;
    setDiffLoadError(null);
    void git.getGitFileDiff(currentDirectory, { path: route.path })
      .then((response) => {
        if (cancelled) return;
        setDiff(currentDirectory, route.path, {
          original: response.original ?? '',
          modified: response.modified ?? '',
          isBinary: response.isBinary,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, diffRetryNonce, getDiff, git, route, setDiff]);

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

  const toggleFileSelection = (path: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setHasUserAdjustedSelection(true);
  };

  const selectAll = () => {
    setSelectedPaths(new Set(changeEntries.map((file) => file.path)));
    setHasUserAdjustedSelection(true);
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
    setHasUserAdjustedSelection(true);
  };

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
    if (selectedPaths.size === 0) {
      toast.error(t('gitView.toast.selectFileToDescribe'));
      return;
    }
    setIsGeneratingMessage(true);
    try {
      const { message } = await generateCommitMessage(currentDirectory, Array.from(selectedPaths));
      setCommitMessage(message.subject?.trim() ?? '');
      setGeneratedHighlights(Array.isArray(message.highlights) ? message.highlights : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.generateCommitMessageFailed'));
    } finally {
      setIsGeneratingMessage(false);
    }
  }, [currentDirectory, selectedPaths, t]);

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (!commitMessage.trim()) {
      toast.error(t('gitView.toast.enterCommitMessage'));
      return;
    }
    const filesToCommit = Array.from(selectedPaths).sort();
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
      setSelectedPaths(new Set());
      setHasUserAdjustedSelection(false);

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

  if (!currentDirectory) {
    return <MobileChangesState message={t('gitView.empty.selectSessionOrDirectory')} />;
  }

  if (isLoadingStatus && isGitRepo === null) {
    return <MobileChangesState loading message={t('gitView.loading.checkingRepository')} />;
  }

  if (isGitRepo === false) {
    return <MobileChangesState icon message={t('gitView.empty.notGitRepository')} description={t('gitView.empty.notGitRepositoryDescription')} />;
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

  return (
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
            <RiCloseLine className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory}
          </p>
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
      </header>
      <ScrollShadow className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {changeEntries.length > 0 ? (
          <div className="flex flex-col gap-4">
            <ChangesSection
              changeEntries={changeEntries}
              selectedPaths={selectedPaths}
              diffStats={status?.diffStats}
              revertingPaths={revertingPaths}
              onToggleFile={toggleFileSelection}
              onSelectAll={selectAll}
              onClearSelection={clearSelection}
              onRevertAll={handleRevertAll}
              onViewDiff={(path) => setRoute({ type: 'diff', path })}
              onRevertFile={handleRevertFile}
              isRevertingAll={isRevertingAll}
              onVisiblePathsChange={setVisibleChangePaths}
              maxListHeightClassName="max-h-[48vh]"
            />
            <CommitSection
              selectedCount={selectedPaths.size}
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
        ) : (
          <MobileChangesState icon message={t('gitView.empty.cleanTitle')} description={t('mobile.changes.cleanDescription')} />
        )}
      </ScrollShadow>
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
      {loading ? <RiLoader4Line className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <RiGitBranchLine className="size-6 text-muted-foreground" /> : null}
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
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/50 px-3 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <RiArrowLeftLine className="size-5" />
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
