import React from 'react';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { ChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { NestedRepoPicker } from './NestedRepoPicker';
import { BranchComparisonSelector } from './BranchComparisonSelector';
import { PullRequestListPanel } from './PullRequestListPanel';
import { isSelectedPullRequest } from './pullRequestSelection';
import { GitDrillHeader } from './GitDrillHeader';
import { GIT_PANEL_REVIEW_MENU_STEP, REVIEW_SCOPE_TOOLBAR_FIT } from './gitPanelHeaderFit';
import { useToolbarFit } from '../useDiffToolbarFit';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { joinProjectPath } from '@/lib/source-control/projectPath';
import { revisionSuffix } from '@/lib/diff/pullRequestDiff';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { ChangeRequestDiffUnavailable } from './ChangeRequestDiffUnavailable';
import { branchRefLabel } from './baseBranch';
import { ChangeScopeSelector } from '../ChangeScopeSelector';
import { DiffViewOptionsMenu } from '../diffView/DiffViewOptionsMenu';
import { MultiFileDiffEntry } from '../diffView/MultiFileDiffEntry';
import { useDiffViewComparisons } from '../diffView/useDiffViewComparisons';
import { useDiffViewEditor } from '../diffView/useDiffViewEditor';
import { useReviewScopeDiffNavigation } from './useReviewScopeDiffNavigation';
import { GitDiffFindBar } from './GitDiffFindBar';
import { EMPTY_COMPARISON_DIFF } from '../diffView/diffData';
import type { DiffData, DiffScope, FileEntry } from '../diffView/types';
import { CommitActionsDropdown, CommitListPanel } from './CommitListPanel';
import { GitSidebarColumn } from './GitSidebarColumn';
import { FileTree } from '../diffView/DiffFileNavigation';
import { useCommitActions, type CommitConflictResult } from './useCommitActions';
import { useSelectedTurnDiff } from '@/hooks/useSelectedTurnDiff';
import { useLastTurnDiff } from '../useLastTurnDiff';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useGitStore, useGitStatus, useIsGitRepo, type NestedRepoDiscovery } from '@/stores/useGitStore';
import { useTurnChipNavigation } from './useTurnChipNavigation';
import { useScrollToSection } from './useScrollToSection';
import { useUIStore, type PendingDiffScope } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { WalkthroughTarget } from '@/lib/walkthrough/types';

interface UnifiedReviewScopeViewProps {
  visible: boolean;
  isWide: boolean;
  rootDirectory: string | undefined;
  effectiveDirectory: string | undefined;
  repositoryOptions?: string[];
  selectedRepository?: string | null;
  onSelectRepository?: (repository: string) => void;
  activeDiffScope: Exclude<DiffScope, 'working' | 'staged' | 'all'>;
  onScopeChange: (scope: PendingDiffScope) => void;
  totalWorkingFileCount: number;
  onStartReview?: () => void;
  reviewSubmitting?: boolean;
  onCopyCommitHash: (hash: string) => void;
  onCommitConflict: (result: CommitConflictResult) => void;
  onCommitActionSuccess: () => void;
  branchDivider?: {
    firstBaseHash: string;
    branchName: string;
    baseName: string;
    direction: 'up' | 'down';
  } | null;
  rootIsGitRepo: boolean | null;
  nestedRepos: NestedRepoDiscovery | undefined;
}

const COMMIT_PAGE_SIZE = 50;


export const UnifiedReviewScopeView: React.FC<UnifiedReviewScopeViewProps> = ({
  visible,
  isWide,
  rootDirectory,
  effectiveDirectory,
  repositoryOptions,
  selectedRepository,
  onSelectRepository,
  activeDiffScope,
  onScopeChange,
  totalWorkingFileCount,
  onStartReview,
  reviewSubmitting = false,
  onCopyCommitHash,
  onCommitConflict,
  onCommitActionSuccess,
  branchDivider = null,
  rootIsGitRepo,
  nestedRepos,
}) => {
  const { t } = useI18n();
  const { git, files, sourceControl } = useRuntimeAPIs();
  const status = useGitStatus(effectiveDirectory ?? null);
  const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const setDiff = useGitStore((state) => state.setDiff);
  const binding = useRepositoryBinding(effectiveDirectory, sourceControl);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
  const pendingTurnDiffFile = useUIStore((state) => state.pendingTurnDiffFile);
  const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
  const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
  const diffFileLayout = useUIStore((state) => state.diffFileLayout);
  const setDiffLayoutForAllFiles = useUIStore((state) => state.setDiffLayoutForAllFiles);
  const diffWrapLines = useUIStore((state) => state.diffWrapLines);
  const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
  const diffHideWhitespace = useUIStore((state) => state.diffHideWhitespace);
  const setDiffHideWhitespace = useUIStore((state) => state.setDiffHideWhitespace);
  const requestWalkthroughTarget = useWalkthroughStore((state) => state.requestTarget);

  const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
  const [selectedFilePath, setSelectedFilePath] = React.useState<string | null>(null);
  const [drilledCommit, setDrilledCommit] = React.useState<string | null>(null);
  const [prDrilled, setPrDrilled] = React.useState(false);
  const [focusTarget, setFocusTarget] = React.useState<'drill' | 'list' | null>(null);
  const [commitLimit, setCommitLimit] = React.useState(COMMIT_PAGE_SIZE);
  const fetchPaths = React.useMemo(() => {
    if (!isWide || !selectedFilePath || expandedFiles.has(selectedFilePath)) return expandedFiles;
    return new Set(expandedFiles).add(selectedFilePath);
  }, [expandedFiles, isWide, selectedFilePath]);

  const { turnId, turnSessionId, reset: resetSelectedTurn } = useSelectedTurnDiff({
    visible,
    isTurnScope: activeDiffScope === 'turn',
    currentSessionId,
    request: pendingTurnDiffFile,
  });
  const { count: latestTurnFileCount } = useLastTurnDiff(currentSessionId, rootDirectory ?? undefined, {
    enabled: visible && Boolean(turnId),
    live: true,
  });

  const noopSetScope = React.useCallback<React.Dispatch<React.SetStateAction<DiffScope>>>((next) => {
    const resolved = next instanceof Function ? next(activeDiffScope) : next;
    if (resolved !== 'all') onScopeChange(resolved);
  }, [activeDiffScope, onScopeChange]);

  const {
    turnFileCount, turnDiffLoaded, turnDiffSettled, turnDiffError, retryTurnDiff, lastTurnDiffData, lastTurnDiffs,
    stagedFileCount, currentBranch, prComparison, pullRequestContext, selectedPr,
    prChangeRequestTerm, commitComparison, selectedCommitHash, branches, setBaseOverride, clearBaseOverride,
    qualifiedBranchBase, branchBaseSource, isBranchBaseResolved, showBranchOption, setComparisonRetryRevision,
    commentOrigin, changeRequestReview, reviewProvider, comparison, commitFiles, commitFilesError, branchFiles,
    branchFilesError, fetchComparisonDiffEntry, loadFullComparisonDiff, comparisonDiffData, comparisonRangeKey, branchFileCount,
    changedFiles,
  } = useDiffViewComparisons({
    currentSessionId: turnSessionId,
    rootDirectory,
    visible,
    activeDiffScope,
    status,
    effectiveDirectory,
    binding,
    setActiveDiffScope: noopSetScope,
    onDiffScopeChange: onScopeChange,
    fetchBranches,
    git,
    isGitRepo,
    diffScope: activeDiffScope,
    turnId,
    expandedFiles: fetchPaths,
    t,
    commitLimit,
  });

  const prDescriptor = useSourceControlProvider(prComparison.provider);
  const turnOrigin = React.useMemo<DiffCommentOrigin>(() => (turnId ? { kind: 'turn', turnId } : { kind: 'turn' }), [turnId]);
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);
  useToolbarFit(toolbarRef, REVIEW_SCOPE_TOOLBAR_FIT);

  const {
    handleHeaderLayoutChange,
    openingEditorFilePath,
    handleOpenInEditor,
    handleRetryComparisonDiff,
  } = useDiffViewEditor({
    setDiffLayoutForAllFiles,
    rootDirectory,
    effectiveDirectory,
    git,
    activeDiffStaged: false,
    setDiff,
    files,
    openContextFileAtLine,
    setComparisonRetryRevision,
  });

  const commitActions = useCommitActions({
    directory: effectiveDirectory,
    onCopyHash: onCopyCommitHash,
    onConflict: onCommitConflict,
    onActionSuccess: () => {
      void commitComparison.refresh();
      onCommitActionSuccess();
    },
  });

  const [prevScopeContext, setPrevScopeContext] = React.useState(`${activeDiffScope}:${effectiveDirectory ?? ''}`);
  const scopeContext = `${activeDiffScope}:${effectiveDirectory ?? ''}`;
  if (prevScopeContext !== scopeContext) {
    setPrevScopeContext(scopeContext);
    setDrilledCommit(null);
    setPrDrilled(Boolean(selectedPr));
    setExpandedFiles(new Set());
    setSelectedFilePath(null);
  }

  const [prevCommitHash, setPrevCommitHash] = React.useState(selectedCommitHash);
  if (activeDiffScope === 'commit' && prevCommitHash !== selectedCommitHash) {
    setPrevCommitHash(selectedCommitHash);
    setExpandedFiles(new Set());
  }

  const commitDrillKey = (hash: string | null) => (hash ? JSON.stringify([currentBranch, hash]) : null);
  const commitDrilled = drilledCommit !== null && drilledCommit === commitDrillKey(selectedCommitHash);

  const [prevSelectedPr, setPrevSelectedPr] = React.useState<typeof selectedPr>(null);
  if (prevSelectedPr !== selectedPr) {
    setPrevSelectedPr(selectedPr);
    setPrDrilled(selectedPr !== null);
    if (activeDiffScope === 'pr') {
      setExpandedFiles(new Set());
      setSelectedFilePath(null);
    }
  }

  if (isWide && changedFiles.length > 0
    && !(selectedFilePath && changedFiles.some((f) => f.path === selectedFilePath))) {
    setSelectedFilePath(changedFiles[0].path);
  }

  const { registerSectionRef, scrollTo } = useScrollToSection();
  const revealTurnFile = React.useCallback((path: string) => {
    setSelectedFilePath(path);
    setExpandedFiles((previous) => (previous.has(path) ? previous : new Set(previous).add(path)));
    scrollTo(path);
  }, [scrollTo]);
  useTurnChipNavigation({
    visible,
    isTurnScope: activeDiffScope === 'turn',
    currentSessionId,
    turnDiffSettled,
    lastTurnDiffs,
    rootDirectory,
    effectiveDirectory,
    rootIsGitRepo,
    nestedRepos,
    repositoryOptions,
    files,
    reveal: revealTurnFile,
  });

  const effectiveLayout: 'inline' | 'side-by-side' = diffLayoutPreference === 'side-by-side' ? 'side-by-side' : 'inline';
  const getLayoutForFile = React.useCallback((path: string): 'inline' | 'side-by-side' => {
    return diffFileLayout[path] ?? effectiveLayout;
  }, [diffFileLayout, effectiveLayout]);

  const handleToggleFileExpanded = React.useCallback((path: string, expanded: boolean) => {
    if (expanded) setSelectedFilePath(path);
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const handleExpandOrCollapseAll = React.useCallback(() => {
    if (expandedFiles.size > 0) {
      setExpandedFiles(new Set());
    } else {
      setExpandedFiles(new Set(changedFiles.map((f) => f.path)));
    }
  }, [changedFiles, expandedFiles.size]);

  const noopRegisterRef = React.useCallback(() => {}, []);

  const filesShown = changedFiles.length > 0
    && (activeDiffScope === 'commit' ? commitDrilled && Boolean(selectedCommitHash)
      : activeDiffScope === 'pr' ? prDrilled && Boolean(selectedPr) : true);

  const commitsList = commitComparison.commits;
  const loadMoreCommits = React.useCallback(() => setCommitLimit((limit) => limit + COMMIT_PAGE_SIZE), []);

  const selectedCommit = React.useMemo(
    () => commitsList.find((c) => c.hash === selectedCommitHash) ?? null,
    [commitsList, selectedCommitHash],
  );

  const resolvedWideFilePath = React.useMemo(() => {
    if (selectedFilePath && changedFiles.some((f) => f.path === selectedFilePath)) {
      return selectedFilePath;
    }
    return changedFiles[0]?.path ?? null;
  }, [changedFiles, selectedFilePath]);

  const { rootRef: findRootRef, diffFind, findFocusNonce, findPropsFor } = useReviewScopeDiffNavigation({
    directory: effectiveDirectory ?? undefined,
    git,
    visible,
    filesShown,
    isWide,
    scope: activeDiffScope,
    changedFiles,
    currentPath: isWide ? resolvedWideFilePath : selectedFilePath,
    reveal: revealTurnFile,
    getLayoutForFile,
    diffHideWhitespace,
    lastTurnDiffData,
    comparisonDiffData,
    comparisonRangeKey,
    loadFullComparisonDiff,
    fetchComparisonDiffEntry,
  });

  const showWalkthroughButton = changedFiles.length > 0 && activeDiffScope !== 'turn' && !isVSCodeRuntime()
    && (activeDiffScope !== 'pr' || Boolean(pullRequestContext));
  const showReviewButton = Boolean(currentSessionId && onStartReview) && activeDiffScope === 'branch' && changedFiles.length > 0 && !isVSCodeRuntime();

  const openWalkthrough = React.useCallback(() => {
    const directory = effectiveDirectory ?? '';
    const localSource: WalkthroughTarget = {
      source: activeDiffScope === 'commit' && selectedCommitHash ? {
        kind: 'commit',
        hash: selectedCommitHash,
      } : activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch ? {
        kind: 'branch',
        baseRef: qualifiedBranchBase,
        headRef: currentBranch,
      } : {
        kind: 'working-tree',
        scope: 'all',
      },
    };
    requestWalkthroughTarget(
      directory,
      activeDiffScope === 'pr' && selectedPr && pullRequestContext
        ? { source: selectedPr, context: pullRequestContext }
        : localSource,
    );
    openContextPanelTab(rootDirectory ?? directory, { mode: 'walkthrough', targetDirectory: null });
  }, [activeDiffScope, currentBranch, effectiveDirectory, openContextPanelTab, pullRequestContext, qualifiedBranchBase, requestWalkthroughTarget, rootDirectory, selectedCommitHash, selectedPr]);

  const renderEntry = (file: FileEntry, singleFile = false) => {
    if (!effectiveDirectory) return null;
    const isExpanded = singleFile || expandedFiles.has(file.path);
    const isComparison = activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr';
    const initialDiffData: DiffData | null = activeDiffScope === 'turn'
      ? (lastTurnDiffData.get(file.path) ?? null)
      : null;

    return (
      <MultiFileDiffEntry
        key={`${activeDiffScope}:${selectedCommitHash ?? ''}:${file.path}`}
        visible={visible}
        directory={effectiveDirectory}
        file={file}
        layout={getLayoutForFile(file.path)}
        wrapLines={diffWrapLines}
        hideWhitespace={diffHideWhitespace}
        isSelected={false}
        isExpanded={isExpanded}
        isMounted={isExpanded}
        hideExpandChevron={singleFile}
        onSelect={() => {}}
        onExpandedChange={singleFile ? () => {} : handleToggleFileExpanded}
        registerSectionRef={singleFile ? noopRegisterRef : registerSectionRef}
        showOpenInEditorAction
        isOpeningInEditor={openingEditorFilePath === file.path}
        onOpenInEditor={handleOpenInEditor}
        staged={false}
        initialDiffData={initialDiffData}
        comparisonDiff={isComparison ? (comparisonDiffData.get(file.path) ?? EMPTY_COMPARISON_DIFF) : undefined}
        commentOrigin={activeDiffScope === 'turn' ? turnOrigin : commentOrigin}
        onRetryComparisonDiff={isComparison ? handleRetryComparisonDiff : undefined}
        loadFullComparisonDiff={isComparison ? loadFullComparisonDiff : undefined}
        readOnlyActions
        hunkActionsEnabled={false}
        {...findPropsFor(file.path)}
      />
    );
  };

  const renderDiffEmptyOrError = (): React.ReactNode | null => {
    if (activeDiffScope === 'pr' && prComparison.diffUnavailable) {
      return <ChangeRequestDiffUnavailable provider={prComparison.provider} className="h-full" />;
    }
    if (activeDiffScope === 'pr' && !selectedPr) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
          {prComparison.error ?? (prComparison.loading
            ? t(changeRequestCopy('session.githubPrPicker.loading.pullRequests', prChangeRequestTerm))
            : t(changeRequestCopy('pullRequestComparison.select', prChangeRequestTerm)))}
        </div>
      );
    }
    if (activeDiffScope === 'branch' && !qualifiedBranchBase) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
          {isBranchBaseResolved ? t('gitView.pr.toast.baseBranchRequired') : t('diffView.branch.resolvingBase')}
        </div>
      );
    }
    if (activeDiffScope === 'turn' && turnDiffError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="typography-ui-label font-semibold text-foreground">{t('diffView.state.failedToLoadDiff')}</p>
          <p className="typography-meta text-muted-foreground">{turnDiffError}</p>
          <Button variant="outline" size="sm" onClick={retryTurnDiff}>{t('diffView.actions.retry')}</Button>
        </div>
      );
    }
    if (activeDiffScope === 'turn' && !turnDiffLoaded && currentSessionId) {
      return (
        <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('diffView.state.loadingChanges')}</span>
        </div>
      );
    }
    const comparisonError = activeDiffScope === 'branch' ? branchFilesError : activeDiffScope === 'commit' ? commitFilesError : activeDiffScope === 'pr' ? comparison.error : null;
    if (comparisonError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="typography-ui-label font-semibold text-foreground">{t('diffView.state.failedToLoadDiff')}</p>
          <p className="typography-meta text-muted-foreground">{comparisonError}</p>
          <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
        </div>
      );
    }
    const comparisonLoading = (activeDiffScope === 'branch' && branchFiles === null)
      || (activeDiffScope === 'commit' && Boolean(selectedCommitHash) && commitFiles === null)
      || (activeDiffScope === 'pr' && Boolean(selectedPr) && comparison.files === null);
    if (comparisonLoading) {
      return (
        <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('diffView.state.loadingChanges')}</span>
        </div>
      );
    }
    if (changedFiles.length === 0) {
      const emptyMessage = activeDiffScope === 'turn'
        ? t('diffView.state.noLastTurnChanges')
        : activeDiffScope === 'pr'
          ? t('walkthrough.blocked.emptyDiff.description')
          : activeDiffScope === 'commit'
            ? t('commitComparison.emptyDiff')
            : activeDiffScope === 'branch' && qualifiedBranchBase
              ? t('diffView.branch.empty', { base: branchRefLabel(qualifiedBranchBase) })
              : t('diffView.state.cleanWorkingTree');
      return (
        <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
          {emptyMessage}
        </div>
      );
    }
    return null;
  };

  const renderSelectPrompt = (message: string) => (
    <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
      {message}
    </div>
  );

  const renderAccordion = () => (
    <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal preventOverscroll data-diff-virtual-root>
      <div className="flex flex-col pb-4" data-diff-virtual-content>
        {changedFiles.map((file) => renderEntry(file, false))}
      </div>
    </ScrollableOverlay>
  );

  const renderSelectedFile = () => {
    const selectedFile = changedFiles.find((f) => f.path === resolvedWideFilePath) ?? null;
    return selectedFile ? (
      <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal preventOverscroll data-diff-virtual-root>
        <div data-diff-virtual-content>{renderEntry(selectedFile, true)}</div>
      </ScrollableOverlay>
    ) : null;
  };

  const renderFileTree = () => (
    <FileTree
      changedFiles={changedFiles}
      selectedFile={resolvedWideFilePath}
      onSelectFile={setSelectedFilePath}
    />
  );

  const commitHeader = selectedCommit ? (
    <GitDrillHeader
      backLabel={t('commitComparison.backToList')}
      onBack={() => {
        setDrilledCommit(null);
        setFocusTarget('list');
      }}
      focusOnMount={focusTarget === 'drill'}
      onFocused={() => setFocusTarget(null)}
      title={selectedCommit.message}
      meta={(
        <>
          <span className="truncate">{selectedCommit.author_name}</span>
          <span>·</span>
          <button
            type="button"
            onClick={() => onCopyCommitHash(selectedCommit.hash)}
            className="inline-flex shrink-0 items-center gap-1 font-mono hover:text-foreground"
            title={t('gitView.history.copySha')}
          >
            {selectedCommit.hash.slice(0, 8)}
            <Icon name="file-copy" className="size-3" />
          </button>
        </>
      )}
      actions={<CommitActionsDropdown entry={selectedCommit} actions={commitActions} />}
    />
  ) : null;

  const selectedPrEntry = selectedPr
    ? prComparison.prs.find((pr) => isSelectedPullRequest(prComparison, pr)) ?? null
    : null;
  const prReference = selectedPr ? formatChangeRequestReference(prDescriptor, selectedPr.number) : '';
  const prRefreshLabel = t('session.githubIssuePicker.actions.refresh');
  const prHeader = selectedPr ? (
    <GitDrillHeader
      backLabel={t('contextPanel.actions.backToPanel', {
        panel: t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', prChangeRequestTerm)),
      })}
      onBack={() => {
        setPrDrilled(false);
        setFocusTarget('list');
        void prComparison.revalidate();
      }}
      focusOnMount={focusTarget === 'drill'}
      onFocused={() => setFocusTarget(null)}
      title={`${prReference}${revisionSuffix(selectedPr)}${selectedPrEntry ? ` ${selectedPrEntry.title}` : ''}`}
      meta={selectedPrEntry ? (
        <span dir="ltr" className="truncate">
          {selectedPrEntry.head} → {selectedPrEntry.base}
        </span>
      ) : selectedPr.sourceRepo ? (
        <span dir="ltr" className="truncate">{joinProjectPath(selectedPr.sourceRepo.owner, selectedPr.sourceRepo.repo)}</span>
      ) : null}
      actions={(
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={comparison.loading}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              aria-label={prRefreshLabel}
              onClick={() => void comparison.refresh()}
            >
              <Icon name="refresh" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{prRefreshLabel}</TooltipContent>
        </Tooltip>
      )}
    />
  ) : null;

  const commitList = (
    <CommitListPanel
      commits={commitsList}
      selectedHash={selectedCommitHash}
      loading={commitComparison.loading}
      error={commitComparison.error}
      onSelectCommit={(commit) => {
        commitComparison.select(commit);
        setDrilledCommit(commitDrillKey(commit.hash));
        setFocusTarget('drill');
      }}
      focusSelected={focusTarget === 'list'}
      onFocused={() => setFocusTarget(null)}
      onRefresh={() => void commitComparison.refresh()}
      onLoadMore={loadMoreCommits}
      hasMore={commitComparison.hasMore}
      actions={commitActions}
      branchDivider={branchDivider}
    />
  );

  const prList = (
    <PullRequestListPanel
      comparison={prComparison}
      onSelect={(pr) => {
        prComparison.select(pr);
        setPrDrilled(true);
        setFocusTarget('drill');
      }}
      focusSelected={focusTarget === 'list'}
      onFocused={() => setFocusTarget(null)}
    />
  );

  const renderDrillScope = (list: React.ReactNode, header: React.ReactNode, drilled: boolean, selectPrompt: string) => {
    const emptyOrError = header ? renderDiffEmptyOrError() : null;
    if (isWide) {
      return (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <GitSidebarColumn>
            {drilled && header ? (
              <>
                {header}
                {emptyOrError ? null : renderFileTree()}
              </>
            ) : list}
          </GitSidebarColumn>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {header ? (emptyOrError ?? renderSelectedFile()) : renderSelectPrompt(selectPrompt)}
          </div>
        </div>
      );
    }
    if (drilled && header) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {header}
          {emptyOrError ?? renderAccordion()}
        </div>
      );
    }
    return list;
  };

  const renderBody = () => {
    if (activeDiffScope === 'commit') {
      return renderDrillScope(commitList, commitHeader, commitDrilled, t('commitComparison.select'));
    }

    if (activeDiffScope === 'pr') {
      return renderDrillScope(prList, prHeader, prDrilled, t(changeRequestCopy('pullRequestComparison.select', prChangeRequestTerm)));
    }

    const emptyOrError = renderDiffEmptyOrError();
    if (emptyOrError) return emptyOrError;

    if (isWide) {
      return (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <GitSidebarColumn>{renderFileTree()}</GitSidebarColumn>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{renderSelectedFile()}</div>
        </div>
      );
    }

    return renderAccordion();
  };

  const showExpandCollapseInToolbar = changedFiles.length > 0 && !isWide
    && (activeDiffScope === 'commit' ? commitDrilled && Boolean(selectedCommit)
      : activeDiffScope === 'pr' ? prDrilled && Boolean(selectedPr) : true);

  return (
    <ChangeRequestReviewContext.Provider value={changeRequestReview}>
      {commitActions.dialogs}
      <ContextPanelHeaderToolbar>
        <div ref={toolbarRef} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pe-1">
          {repositoryOptions && onSelectRepository ? (
            <NestedRepoPicker
              repositories={repositoryOptions}
              selectedRepository={selectedRepository ?? null}
              onSelectRepository={onSelectRepository}
              repositoryRoot={rootDirectory}
            />
          ) : null}
          <ChangeScopeSelector
            scope={activeDiffScope}
            historicalTurn={turnId ? { count: turnFileCount } : null}
            workingCount={totalWorkingFileCount}
            stagedCount={stagedFileCount}
            turnCount={turnId ? latestTurnFileCount : turnFileCount}
            branchCount={branchFileCount}
            commitCount={activeDiffScope === 'commit' ? commitFiles?.length ?? null : null}
            prCount={activeDiffScope === 'pr' ? comparison.files?.length ?? null : null}
            showCommitOption={!isVSCodeRuntime()}
            showBranchOption={showBranchOption}
            hideStagedOption
            changeRequestTerm={prChangeRequestTerm}
            onScopeChange={(scope) => {
              resetSelectedTurn();
              setPendingTurnDiffFile(null);
              onScopeChange(scope);
            }}
          />
          {activeDiffScope === 'branch' ? (
            <BranchComparisonSelector
              key={JSON.stringify([effectiveDirectory, currentBranch])}
              branches={branches?.all ?? []}
              defaultBranches={branches?.defaultBranches}
              primaryRemote={binding.contexts[0]?.primaryRemote}
              currentBranch={currentBranch}
              base={qualifiedBranchBase}
              automatic={branchBaseSource !== 'chosen'}
              onSelect={(base) => {
                if (effectiveDirectory && currentBranch) setBaseOverride(effectiveDirectory, currentBranch, base);
              }}
              onSelectAutomatic={() => {
                if (effectiveDirectory && currentBranch) clearBaseOverride(effectiveDirectory, currentBranch);
              }}
            />
          ) : null}
          <div className="min-w-0 flex-1" />

          {changeRequestReview && reviewProvider ? (
            <ReviewSubmitButton review={changeRequestReview} provider={reviewProvider} />
          ) : null}

          {showReviewButton ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onStartReview}
                  disabled={reviewSubmitting}
                  className="git-header__review-button h-7 shrink-0 gap-1.5 px-2"
                  aria-label={t('diffView.actions.reviewAria')}
                >
                  {reviewSubmitting
                    ? <Icon name="loader-4" className="size-4 animate-spin" />
                    : <Icon name="search-eye" className="size-4 text-[var(--primary-text)]" />}
                  <span className="git-header__review-label typography-ui-label">{t('chat.work.reviewHint.aiReview')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.review')}</TooltipContent>
            </Tooltip>
          ) : null}

          {showWalkthroughButton ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openWalkthrough}
                  className="git-header__review-button h-7 shrink-0 gap-1.5 px-2"
                  aria-label={t('walkthrough.action.open')}
                >
                  <Icon name="route" className="size-4" />
                  <span className="git-header__review-label typography-ui-label">{t('walkthrough.action.open')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.walkthrough')}</TooltipContent>
            </Tooltip>
          ) : null}

          <DiffViewOptionsMenu
            diffWrapLines={diffWrapLines}
            onToggleWrapLines={() => setDiffWrapLines(!diffWrapLines)}
            diffHideWhitespace={diffHideWhitespace}
            onToggleHideWhitespace={() => setDiffHideWhitespace(!diffHideWhitespace)}
            currentLayoutForAllFiles={effectiveLayout}
            onLayoutChange={handleHeaderLayoutChange}
            showExpandCollapseAll={showExpandCollapseInToolbar && !isWide}
            anyExpanded={expandedFiles.size > 0}
            onToggleExpandCollapseAll={handleExpandOrCollapseAll}
            foldedReview={{
              toolbarRef,
              step: GIT_PANEL_REVIEW_MENU_STEP,
              onStartReview: showReviewButton ? onStartReview : undefined,
              reviewSubmitting,
              onOpenWalkthrough: showWalkthroughButton ? openWalkthrough : undefined,
            }}
          />
        </div>
      </ContextPanelHeaderToolbar>

      <div ref={findRootRef} data-find-surface="" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <GitDiffFindBar find={diffFind} focusNonce={findFocusNonce} />
        {renderBody()}
      </div>
    </ChangeRequestReviewContext.Provider>
  );
};
