import React from 'react';
import { useSelectedTurnDiff } from '@/hooks/useSelectedTurnDiff';
import { useLastTurnDiff } from './useLastTurnDiff';
import type { DiffViewProps, DiffScope, FileEntry } from './diffView/types';
import { ChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { findDiffScrollAnchor, type DiffScrollAnchor } from './diffScrollAnchor';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useDiffViewComparisons } from './diffView/useDiffViewComparisons';
import { useDiffViewStackedViewport } from './diffView/useDiffViewStackedViewport';
import { useDiffViewRefresh } from './diffView/useDiffViewRefresh';
import { useDiffViewNavigation } from './diffView/useDiffViewNavigation';
import { useDiffViewTurnNavigation } from './diffView/useDiffViewTurnNavigation';
import { useDiffViewScrollAlignment } from './diffView/useDiffViewScrollAlignment';
import { useDiffViewTreeLayout } from './diffView/useDiffViewTreeLayout';
import { useDiffViewStackedEntries } from './diffView/useDiffViewStackedEntries';
import { useDiffViewFileSelection } from './diffView/useDiffViewFileSelection';
import { useDiffViewFind } from './diffView/useDiffViewFind';
import { useDiffViewEditor } from './diffView/useDiffViewEditor';
import { DiffViewToolbar } from './diffView/DiffViewToolbar';
import { MultiFileDiffEntry } from './diffView/MultiFileDiffEntry';
import { StackedDiffWindow, STACKED_DIFF_WINDOW_THRESHOLD } from './diffView/StackedDiffWindow';
import { useStackedLiveRows } from '@/hooks/useStackedLiveRows';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DiffFindBar } from './diffFind/DiffFindBar';
import { EMPTY_COMPARISON_DIFF, isFindRevealFor } from './diffView/diffData';
import { FileList, FileTree } from './diffView/DiffFileNavigation';
import { ChangeRequestDiffUnavailable } from './git/ChangeRequestDiffUnavailable';
import { GitRepositoryUnreadableState } from './git/GitRepositoryUnreadableState';
import { branchRefLabel } from './git/baseBranch';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { PullRequestComparisonSelector } from './git/PullRequestComparisonSelector';
import { ChangeScopeSelector } from './ChangeScopeSelector';
import { CommitComparisonSelector } from './git/CommitComparisonSelector';
import { NestedRepoPicker } from './git/NestedRepoPicker';
import { BranchComparisonSelector } from './git/BranchComparisonSelector';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import type { WalkthroughTarget } from '@/lib/walkthrough/types';
export { MultiFileDiffEntry } from './diffView/MultiFileDiffEntry';

export const DiffView: React.FC<DiffViewProps> = ({
    visible = true,
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
    showOpenInEditorAction = false,
    diffScope = 'all',
    onDiffScopeChange,
    targetFilePath = null,
    flushContent = false,
    directory: targetDirectory = null,
}) => {

    const { t } = useI18n();
    const { git, files, sourceControl } = useRuntimeAPIs();
    const panelDirectory = useEffectiveDirectory();
    const foreign = Boolean(targetDirectory);
    const rootDirectory = targetDirectory ?? panelDirectory;
    const runtimeKey = useGitStore((state) => state.runtimeKey);
    const {
        gitDirectory: nestedGitDirectory, rootIsGitRepo, nestedRepos, repositoryOptions, repositoriesKnown,
        unreadable,
    } = useNestedGitDirectory(rootDirectory ?? null, { enabled: visible, recheckOnOpen: true });
    const effectiveDirectory = nestedGitDirectory ?? rootDirectory;
    const binding = useRepositoryBinding(effectiveDirectory, sourceControl);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const requestWalkthroughTarget = useWalkthroughStore((state) => state.requestTarget);
    const { screenWidth, isMobile } = useDeviceInfo();
    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitLoadingStatus(effectiveDirectory ?? null);
    const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
    const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
    const [liveStackedFiles, handleStackedLiveChange] = useStackedLiveRows();
    const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
    const [fileDiffRefreshNonce, setFileDiffRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
    const [workingTreeRevision, setWorkingTreeRevision] = React.useState(0);
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [activeDiffScope, setActiveDiffScope] = React.useState<DiffScope>(
        diffScope === null && !isVSCodeRuntime() ? 'branch' : diffScope ?? 'working'
    );
    React.useEffect(() => {
        if (diffScope !== null) setActiveDiffScope(diffScope);
    }, [diffScope]);
    const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
    const pendingDiffStaged = useUIStore((state) => state.pendingDiffStaged);
    const pendingDiffScope = useUIStore((state) => state.pendingDiffScope);
    const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
    const pendingTurnDiffFile = useUIStore((state) => state.pendingTurnDiffFile);
    const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const diffFileLayout = useUIStore((state) => state.diffFileLayout);
    const setDiffLayoutForAllFiles = useUIStore((state) => state.setDiffLayoutForAllFiles);
    const diffWrapLinesStore = useUIStore((state) => state.diffWrapLines);
    const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
    const diffHideWhitespace = useUIStore((state) => state.diffHideWhitespace);
    const setDiffHideWhitespace = useUIStore((state) => state.setDiffHideWhitespace);
    const diffFileListMode = useUIStore((state) => state.diffFileListMode);
    const setDiffFileListMode = useUIStore((state) => state.setDiffFileListMode);
    const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
    const panelSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionId = foreign ? null : panelSessionId;
    const { turnId, turnSessionId, reset: resetSelectedTurn } = useSelectedTurnDiff({
        visible, isTurnScope: activeDiffScope === 'turn', currentSessionId, request: pendingTurnDiffFile,
    });
    const { count: latestTurnFileCount } = useLastTurnDiff(currentSessionId, rootDirectory ?? undefined, {
        enabled: visible && Boolean(turnId), live: true,
    });
    const diffWrapLines = diffWrapLinesStore;
    const forcedStaged = activeDiffScope === 'staged' ? true : activeDiffScope === 'working' ? false : null;
    const activeDiffStaged = forcedStaged ?? displayFileStaged;
    const isMobileLayout = isMobile || screenWidth <= 768;
    const isTreeMode = diffFileListMode === 'tree' && !isMobileLayout;
    const showReviewAction = Boolean(currentSessionId) && activeDiffScope !== 'turn' && activeDiffScope !== 'commit' && activeDiffScope !== 'pr' && !isMobileLayout && !isVSCodeRuntime();
    const showWalkthroughAction = activeDiffScope !== 'turn' && !isMobileLayout && !isVSCodeRuntime();
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
    const diffContentRef = React.useRef<HTMLDivElement | null>(null);
    const diffRootRef = React.useRef<HTMLDivElement | null>(null);
    const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
    const stackedRowRefs = React.useRef(new Map<string, HTMLDivElement>());
    const registerStackedRow = React.useCallback((path: string, node: HTMLDivElement | null) => {
        if (node) stackedRowRefs.current.set(path, node);
        else stackedRowRefs.current.delete(path);
    }, []);
    const getFileSection = React.useCallback(
        (path: string) => stackedRowRefs.current.get(path) ?? fileSectionRefs.current.get(path),
        [],
    );
    const pendingScrollTargetRef = React.useRef<string | null>(null);
    const pendingScrollFrameRef = React.useRef<number | null>(null);
    const shouldPinAfterAlignRef = React.useRef(false);
    const lastScrollAnchorRef = React.useRef<DiffScrollAnchor | null>(null);
    const pendingScrollAnchorRestoreRef = React.useRef<DiffScrollAnchor | null>(null);
    const captureScrollAnchor = React.useCallback((): DiffScrollAnchor | null => {
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return null;
        const rootTop = scrollRoot.getBoundingClientRect().top;
        const stack = scrollRoot.querySelector('[data-stacked-diff-rows]');
        if (stack && stackedRowRefs.current.size) {
            let low = 0;
            let high = stack.children.length - 1;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (stack.children[middle].getBoundingClientRect().top <= rootTop) low = middle;
                else high = middle - 1;
            }
            const row = stack.children[low];
            const path = row?.getAttribute('data-stacked-diff-path');
            if (path) return { path, topOffset: row.getBoundingClientRect().top - rootTop };
        }
        const sections: Array<{ path: string; top: number }> = [];
        for (const [path, node] of fileSectionRefs.current) {
            if (node) sections.push({ path, top: node.getBoundingClientRect().top });
        }
        return findDiffScrollAnchor(rootTop, sections);
    }, []);
    const cancelPendingScrollAlignment = React.useCallback(() => {
        pendingScrollTargetRef.current = null;
        shouldPinAfterAlignRef.current = false;
        setPinnedStackedTarget(null);
        if (pendingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
        }
    }, []);
    const expandStackedFile = React.useCallback((path: string) => {
        setExpandedFiles((previous) => {
            if (previous.has(path)) {
                return previous;
            }
            const next = new Set(previous);
            next.add(path);
            return next;
        });
    }, []);
    const {
        lastTurnDiffs, turnFileCount, turnDiffLoaded, turnDiffSettled, turnDiffError, retryTurnDiff, lastTurnDiffData,
        workingFileCount, stagedFileCount, currentBranch, prComparison, pullRequestContext, selectedPr,
        prChangeRequestTerm, commitComparison, selectedCommitHash, branches, setBaseOverride, clearBaseOverride,
        qualifiedBranchBase, branchBaseSource, isBranchBaseResolved, showBranchOption, setComparisonRetryRevision,
        commentOrigin, changeRequestReview, reviewProvider, comparison, commitFiles, commitFilesError, branchFiles,
        branchFilesError, fetchComparisonDiffEntry, loadFullComparisonDiff, comparisonDiffData, comparisonRangeKey, branchFileCount,
        comparisonPathRevisions, changedFiles, changedFilePathsKey } = useDiffViewComparisons({ currentSessionId: turnSessionId, rootDirectory, visible,
        activeDiffScope, status, effectiveDirectory, binding, setActiveDiffScope, onDiffScopeChange, fetchBranches, git,
        isGitRepo, diffScope, turnId, expandedFiles,
        liveStackedFiles: isTreeMode ? undefined : liveStackedFiles, t,
    });
    const {
        registerSectionRef, handleStackedEntryExpandedChange, handleExpandOrCollapseAll, getLayoutForFile,
        currentLayoutForAllFiles } = useDiffViewStackedViewport({ changedFilePathsKey, effectiveDirectory,
        activeDiffScope, stackedDefaultCollapsedAll, setExpandedFiles, setMountedStackedFiles,
        visible, diffScrollRef, fileSectionRefs, expandedFiles, lastScrollAnchorRef, changedFiles,
        diffFileLayout, diffLayoutPreference, screenWidth, cancelPendingScrollAlignment,
    });
    useDiffViewRefresh({ visible, effectiveDirectory, setActiveDirectory, ensureStatus, git, runtimeKey, pendingScrollAnchorRestoreRef, captureScrollAnchor, lastScrollAnchorRef, clearDiffCache, setFileDiffRefreshNonce, setWorkingTreeRevision, fetchStatus, diffScrollRef, getFileSection, fileDiffRefreshNonce });
    const scrollRequestContextKey = `${effectiveDirectory ?? ''}\0${activeDiffScope}`;
    const branchBaseKey = branchBaseSource === 'chosen' ? qualifiedBranchBase : branchBaseSource && 'automatic';
    const comparisonSelection = activeDiffScope === 'pr' ? selectedPr
        : activeDiffScope === 'commit' ? selectedCommitHash
        : activeDiffScope === 'branch' ? branchBaseKey : null;
    const scrollComparisonKey = status && comparisonSelection ? JSON.stringify(comparisonSelection) : null;
    useDiffViewNavigation({ visible, activeDiffScope, pendingDiffScope,
        pendingDiffFile, setActiveDiffScope, setDisplayFile, setDisplayFileStaged, pendingDiffStaged, setPendingDiffFile,
        shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce, targetFilePath,
    });
    useDiffViewTurnNavigation({
        visible, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged,
        shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce,
        pendingTurnDiffFile, diffScope, panelSessionId: currentSessionId, setPendingTurnDiffFile, turnDiffSettled, rootDirectory,
        lastTurnDiffs, onDiffScopeChange,
        effectiveDirectory, repositoriesKnown, rootIsGitRepo, nestedRepos, repositoryOptions, selectNestedRepo, fetchStatus, git,
        changedFiles, files,
    });
    React.useEffect(() => {
        if (!displayFile) {
            return;
        }
        const stillExists = changedFiles.some((file) => file.path === displayFile);
        if (!stillExists) {
            setDisplayFile(null);
            setDisplayFileStaged(false);
        }
    }, [changedFiles, displayFile]);
    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), []);
    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, rootDirectory, closeReviewDialog);
    const { scrollToFile } = useDiffViewScrollAlignment({ getFileSection, diffScrollRef, diffContentRef,
        pendingScrollTargetRef, visible, shouldPinAfterAlignRef,
        setPinnedStackedTarget, pendingScrollFrameRef, pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce,
        requestContextKey: scrollRequestContextKey, comparisonKey: scrollComparisonKey,
    });
    const windowStackedRows = !isTreeMode && changedFiles.length >= STACKED_DIFF_WINDOW_THRESHOLD;
    const revealStackedFindFile = React.useCallback((path: string) => {
        if (windowStackedRows) {
            setMountedStackedFiles((previous) => previous.has(path) ? previous : new Set(previous).add(path));
        }
        scrollToFile(path);
    }, [scrollToFile, windowStackedRows]);
    const { stackedEntryCount, stackedEntriesPending } = useDiffViewStackedEntries({
        enabled: !isTreeMode, windowed: windowStackedRows, effectiveDirectory, activeDiffScope, changedFiles, scrollRequestNonce,
    });
    const {
        fileTreeLayoutRef, draggingFileTree, fileTreeWidth,
        handleFileTreeResizeStart, handleFileTreeResizeKey } = useDiffViewTreeLayout();
    const {
        treeSelectedFile, handleSelectFileAndScroll, getFileStaged, handleSelectFile,
    } = useDiffViewFileSelection({ isTreeMode, changedFiles, displayFile, expandedFiles, expandStackedFile,
        cancelPendingScrollAlignment, setDisplayFile, setDisplayFileStaged, diffScrollRef, shouldPinAfterAlignRef,
        pendingScrollTargetRef, setScrollRequestNonce, scrollToFile, visible, forcedStaged, displayFileStaged,
    });
    const {
        handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest,
        findFocusNonce } = useDiffViewFind({ effectiveDirectory, git, diffHideWhitespace, getFileStaged, activeDiffScope,
        lastTurnDiffData, comparisonDiffData, comparisonRangeKey, comparisonPathRevisions, loadFullComparisonDiff, fetchComparisonDiffEntry, getLayoutForFile,
        changedFiles, workingTreeRevision, fileDiffRefreshNonce, isTreeMode, displayFile, setDisplayFile,
        setDisplayFileStaged, expandStackedFile, scrollToFile: revealStackedFindFile, cancelScrollHold: cancelPendingScrollAlignment, visible, diffRootRef,
    });
    const {
        handleHeaderLayoutChange, openingEditorFilePath, handleOpenInEditor,
        handleRetryComparisonDiff } = useDiffViewEditor({ setDiffLayoutForAllFiles, rootDirectory, effectiveDirectory,
        git, activeDiffStaged, setDiff, files, openContextFileAtLine, setComparisonRetryRevision,
    });
    const pinnedStackedFiles = React.useMemo(() => {
        const paths = new Set<string>();
        if (pinnedStackedTarget) paths.add(pinnedStackedTarget);
        if (diffFind.isOpen && findReveal) {
            const file = changedFiles.find(({ path }) => isFindRevealFor(path, findReveal.key));
            if (file) paths.add(file.path);
        }
        return paths;
    }, [changedFiles, diffFind.isOpen, findReveal, pinnedStackedTarget]);
    const renderStackedDiffView = () => {
        if (!effectiveDirectory) return null;
        const renderEntry = (file: FileEntry, isSingleFile = false, handles?: Pick<React.ComponentProps<typeof MultiFileDiffEntry>, 'retentionRef' | 'headerRef'>) => {
            const isExpanded = isSingleFile || expandedFiles.has(file.path);
            return (
                <MultiFileDiffEntry
                    visible={visible && isExpanded}
                    key={`${getRuntimeKey()}:${effectiveDirectory}:${file.path}`}
                    directory={effectiveDirectory}
                    file={file}
                    layout={getLayoutForFile(file)}
                    wrapLines={diffWrapLines}
                    hideWhitespace={diffHideWhitespace}
                    isSelected={false}
                    isExpanded={isExpanded}
                    isMounted={isSingleFile || mountedStackedFiles.has(file.path) || file.path === pinnedStackedTarget}
                    onSelect={handleSelectFile}
                    onExpandedChange={handleStackedEntryExpandedChange}
                    {...handles}
                    registerSectionRef={registerSectionRef}
                    registerViewerRef={registerViewerRef}
                    onFindWordRequest={handleFindWordRequest}
                    onFullContextChange={handleFullContextChange}
                    findReveal={diffFind.isOpen && findReveal && isFindRevealFor(file.path, findReveal.key) ? findReveal : null}
                    showOpenInEditorAction={showOpenInEditorAction && activeDiffScope !== 'turn' && !foreign && !(activeDiffScope === 'pr' && selectedPr?.linked)}
                    isOpeningInEditor={openingEditorFilePath === file.path}
                    onOpenInEditor={handleOpenInEditor}
                    staged={getFileStaged(file.path)}
                    readOnlyActions={activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'}
                    hunkActionsEnabled={activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged'}
                    contentRevision={workingTreeRevision + (fileDiffRefreshNonce.get(file.path) ?? 0)}
                    comparisonDiff={activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'
                        ? comparisonDiffData.get(file.path) ?? EMPTY_COMPARISON_DIFF
                        : undefined}
                    commentOrigin={commentOrigin}
                    onRetryComparisonDiff={handleRetryComparisonDiff}
                    loadFullComparisonDiff={loadFullComparisonDiff}
                    initialDiffData={activeDiffScope === 'turn' ? lastTurnDiffData.get(file.path) ?? null : null}
                />
            );
        };
        return (
            <div ref={fileTreeLayoutRef} className={cn('flex min-w-0 flex-1 min-h-0 h-full', flushContent ? 'gap-0' : 'gap-3 px-3 pb-3 pt-2')}>
                {isTreeMode && (
                    <>
                        <section className="flex max-w-[50%] flex-shrink-0 flex-col" style={{ width: `${fileTreeWidth}px` }}>
                            <FileTree changedFiles={changedFiles} selectedFile={treeSelectedFile?.path ?? null} onSelectFile={handleSelectFileAndScroll} />
                        </section>
                        <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={t('diffView.fileTree.resize')}
                            tabIndex={0}
                            onPointerDown={handleFileTreeResizeStart}
                            onKeyDown={handleFileTreeResizeKey}
                            className={cn(
                                'relative w-px shrink-0 cursor-col-resize bg-[var(--interactive-border)]/40',
                                'before:absolute before:inset-y-0 before:-inset-s-1 before:-inset-e-1 before:content-[\'\']',
                                'hover:bg-interactive-selection focus-visible:bg-interactive-selection focus-visible:outline-none',
                                draggingFileTree && 'bg-interactive-selection'
                            )}
                        />
                    </>
                )}
                {showFileSidebar && !isTreeMode && (
                    <section className="hidden lg:flex w-72 flex-col rounded-xl border border-edge bg-background/70 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-edge-muted">
                            <span className="typography-ui-header font-semibold text-foreground">{t('diffView.section.files')}</span>
                            <span className="typography-meta text-muted-foreground">{changedFiles.length}</span>
                        </div>
                        <FileList changedFiles={changedFiles} selectedFile={null} onSelectFile={handleSelectFileAndScroll} />
                    </section>
                )}
                <div className="relative flex-1 min-w-0 min-h-0 h-full">
                    {diffFind.isOpen && (
                        <DiffFindBar
                            query={diffFind.query}
                            onQueryChange={diffFind.setQuery}
                            total={diffFind.matches.length}
                            currentIndex={diffFind.currentIndex}
                            isSearching={diffFind.isSearching}
                            failedCount={diffFind.failedCount}
                            onNext={diffFind.next}
                            onPrevious={diffFind.previous}
                            onClose={diffFind.close}
                            focusNonce={findFocusNonce}
                        />
                    )}
                    <ScrollableOverlay
                        ref={diffScrollRef}
                        outerClassName="min-h-0 h-full"
                        disableHorizontal
                        observeMutations={false}
                        preventOverscroll
                        data-diff-virtual-root={windowStackedRows ? 'windowed' : ''}
                    >
                        <div ref={diffContentRef} className="flex flex-col pb-16" data-diff-virtual-content>
                            {isTreeMode
                                ? treeSelectedFile && renderEntry(treeSelectedFile, true)
                                : (
                                    <StackedDiffWindow
                                        key={JSON.stringify([runtimeKey, effectiveDirectory])}
                                        files={stackedEntriesPending ? changedFiles.slice(0, stackedEntryCount) : changedFiles}
                                        windowed={windowStackedRows}
                                        scrollRef={diffScrollRef}
                                        expandedFiles={expandedFiles}
                                        pinnedFiles={pinnedStackedFiles}
                                        registerPlaceholder={registerStackedRow}
                                        onActivate={handleStackedEntryExpandedChange}
                                        onLiveChange={handleStackedLiveChange}
                                        renderEntry={(file, handles) => renderEntry(file, false, handles)}
                                    />
                                )}
                        </div>
                    </ScrollableOverlay>
                </div>
            </div>
        );
    };
    const renderContent = () => {
        if (!effectiveDirectory) {
            return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('diffView.state.selectSessionDirectory')}</div>;
        }
        if (activeDiffScope !== 'turn' && unreadable) {
            return <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />;
        }
        if (activeDiffScope !== 'turn' && isLoadingStatus && !status) {
            return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingRepositoryStatus')}
            </div>;
        }
        if (activeDiffScope !== 'turn' && isGitRepo === false) {
            return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('diffView.state.notGitRepository')}</div>;
        }
        if (activeDiffScope === 'pr') {
            if (prComparison.diffUnavailable) return <ChangeRequestDiffUnavailable provider={prComparison.provider} />;
            if (!selectedPr || comparison.error) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    {!comparison.error && !prComparison.error && !prComparison.loading
                        && <Icon name="git-pull-request" className="size-6 text-muted-foreground" />}
                    <p className="typography-meta text-muted-foreground">{comparison.error ?? prComparison.error ?? (prComparison.loading
                        ? t(changeRequestCopy('session.githubPrPicker.loading.pullRequests', prChangeRequestTerm))
                        : t(changeRequestCopy('pullRequestComparison.pickAbove', prChangeRequestTerm)))}</p>
                    {(comparison.error || prComparison.error) && <Button variant="outline" size="sm" onClick={() => {
                        if (selectedPr) void comparison.refresh();
                        else void prComparison.refresh();
                    }}>{t('diffView.actions.retry')}</Button>}
                </div>;
            }
            if (!comparison.files) return <div className="flex flex-1 items-center justify-center gap-2 typography-meta text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingDiff')}
            </div>;
        }
        if (activeDiffScope === 'commit') {
            if (commitFilesError) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    <p className="typography-meta text-muted-foreground">{commitFilesError}</p>
                    <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
                </div>;
            }
            if (!selectedCommitHash && !commitComparison.loading) {
                return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {commitComparison.error ?? t('commitComparison.noCommits')}
                </div>;
            }
            if (!commitFiles) {
                return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingDiff')}
                </div>;
            }
        }
        if (activeDiffScope === 'branch') {
            const baseInputsLoading = status === null || binding.status === 'idle' || binding.status === 'loading';
            if (!isBranchBaseResolved || (!qualifiedBranchBase && baseInputsLoading)) {
                return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.branch.resolvingBase')}
                </div>;
            }
            if (!qualifiedBranchBase) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <Icon name="git-branch" className="size-6 text-muted-foreground" />
                    <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.noBaseTitle')}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{t('gitView.pr.toast.baseBranchRequired')}</div>
                </div>;
            }
            if (branchFilesError) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.loadError')}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{branchFilesError}</div>
                    <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
                </div>;
            }
            if (branchFiles === null) {
                return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.branch.loadingFiles')}
                </div>;
            }
        }
        if (activeDiffScope === 'turn' && turnDiffError) {
            return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                <div className="typography-ui-label font-semibold text-foreground">{t('diffView.state.failedToLoadDiff')}</div>
                <div className="typography-meta max-w-[32rem] text-center">{turnDiffError}</div>
                <button type="button" className="typography-ui-label text-primary hover:underline" onClick={retryTurnDiff}>{t('diffView.actions.retry')}</button>
            </div>;
        }
        if (activeDiffScope === 'turn' && (!turnDiffLoaded || pendingTurnDiffFile) && turnSessionId) {
            return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingChanges')}
            </div>;
        }
        if (changedFiles.length === 0) {
            return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {activeDiffScope === 'turn' ? t('diffView.state.noLastTurnChanges')
                    : activeDiffScope === 'pr' ? t('walkthrough.blocked.emptyDiff.description')
                    : activeDiffScope === 'commit' ? t('commitComparison.emptyDiff')
                    : activeDiffScope === 'branch' && qualifiedBranchBase ? t('diffView.branch.empty', { base: branchRefLabel(qualifiedBranchBase) })
                    : t('diffView.state.cleanWorkingTree')}
            </div>;
        }
        return renderStackedDiffView();
    };
    const showWalkthroughButton = changedFiles.length > 0 && showWalkthroughAction && (activeDiffScope !== 'pr' || Boolean(pullRequestContext));
    const openWalkthrough = () => {
        const directory = effectiveDirectory ?? '';
        const localSource: WalkthroughTarget = {
            source: activeDiffScope === 'commit' && selectedCommitHash ? {
                kind: 'commit', hash: selectedCommitHash,
            } : activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch ? {
                kind: 'branch', baseRef: qualifiedBranchBase, headRef: currentBranch,
            } : {
                kind: 'working-tree',
                scope: activeDiffScope === 'staged' || activeDiffScope === 'working' ? activeDiffScope : 'all',
            },
        };
        requestWalkthroughTarget(directory, activeDiffScope === 'pr' && selectedPr && pullRequestContext
            ? { source: selectedPr, context: pullRequestContext }
            : localSource);
        if (foreign && panelDirectory) openContextPanelTab(panelDirectory, { mode: 'walkthrough', targetDirectory: rootDirectory });
        else openContextPanelTab(rootDirectory ?? directory, { mode: 'walkthrough', targetDirectory: null });
    };
    return (
        <ChangeRequestReviewContext.Provider value={changeRequestReview}>
            <div ref={diffRootRef} data-find-surface="" className="flex h-full flex-col overflow-hidden bg-background">
                <DiffViewToolbar
                    hasFiles={changedFiles.length > 0}
                    isMobileLayout={isMobileLayout}
                    diffFileListMode={diffFileListMode}
                    setDiffFileListMode={setDiffFileListMode}
                    diffWrapLines={diffWrapLines}
                    setDiffWrapLines={setDiffWrapLines}
                    diffWrapLinesStore={diffWrapLinesStore}
                    diffHideWhitespace={diffHideWhitespace}
                    setDiffHideWhitespace={setDiffHideWhitespace}
                    currentLayoutForAllFiles={currentLayoutForAllFiles}
                    handleHeaderLayoutChange={handleHeaderLayoutChange}
                    showWalkthroughButton={showWalkthroughButton}
                    openWalkthrough={openWalkthrough}
                >
                    {repositoryOptions ? (
                        <NestedRepoPicker
                            repositories={repositoryOptions}
                            selectedRepository={nestedGitDirectory ?? null}
                            onSelectRepository={(repository) => {
                                if (rootDirectory) selectNestedRepo(rootDirectory, repository);
                            }}
                            repositoryRoot={rootDirectory ?? undefined}
                        />
                    ) : null}
                    {!isMobile && !foreign && (
                        activeDiffScope !== 'all' ? (
                            <ChangeScopeSelector
                                scope={activeDiffScope}
                                historicalTurn={turnId ? { count: turnFileCount } : null}
                                workingCount={workingFileCount}
                                stagedCount={stagedFileCount}
                                turnCount={turnId ? latestTurnFileCount : turnFileCount}
                                branchCount={branchFileCount}
                                commitCount={activeDiffScope === 'commit' ? commitFiles?.length ?? null : null}
                                prCount={activeDiffScope === 'pr' ? comparison.files?.length ?? null : null}
                                showCommitOption={!isVSCodeRuntime()}
                                showBranchOption={showBranchOption}
                                changeRequestTerm={prChangeRequestTerm}
                                onScopeChange={(scope) => {
                                    resetSelectedTurn();
                                    setPendingTurnDiffFile(null);
                                    setActiveDiffScope(scope);
                                    onDiffScopeChange?.(scope);
                                }}
                            />
                        ) : (
                            <div className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground shrink-0">
                                <span className="typography-ui-label font-semibold text-foreground">
                                    {isLoadingStatus && !status
                                        ? t('diffView.state.loadingChanges')
                                        : (changedFiles.length === 1
                                            ? t('diffView.summary.changedFilesSingle', { count: changedFiles.length })
                                            : t('diffView.summary.changedFilesPlural', { count: changedFiles.length }))}
                                </span>
                            </div>
                        )
                    )}
                    {activeDiffScope === 'branch' && (
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
                    )}
                    {activeDiffScope === 'commit' && (
                        <CommitComparisonSelector
                            key={JSON.stringify([effectiveDirectory, currentBranch])}
                            commits={commitComparison.commits}
                            selectedHash={selectedCommitHash}
                            loading={commitComparison.loading}
                            error={commitComparison.error}
                            onSelect={commitComparison.select}
                            onRefresh={() => void commitComparison.refresh()}
                        />
                    )}
                    {activeDiffScope === 'pr' && <>
                        <PullRequestComparisonSelector key={JSON.stringify([runtimeKey, effectiveDirectory, currentBranch])} comparison={prComparison} />
                        {selectedPr && <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex flex-shrink-0">
                                    <Button variant="ghost" size="sm" disabled={comparison.loading}
                                        aria-label={t('session.githubIssuePicker.actions.refresh')}
                                        onClick={() => void comparison.refresh()}><Icon name="refresh" className="size-4" /></Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('session.githubIssuePicker.actions.refresh')}</TooltipContent>
                        </Tooltip>}
                    </>}
                    {changedFiles.length > 0 && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleExpandOrCollapseAll}
                                    className={cn(
                                        'diff-toolbar__expand-button h-7 flex-shrink-0 gap-1 px-1.5 text-muted-foreground hover:text-foreground',
                                        'ms-auto',
                                    )}
                                >
                                    <Icon name="expand-up-down" className="size-4" />
                                    <span className="diff-toolbar__expand-label typography-ui-label">
                                        {expandedFiles.size > 0 ? t('diffView.actions.collapseAll') : t('diffView.actions.expandAll')}
                                    </span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>
                                {expandedFiles.size > 0 ? t('contextTooltips.diff.collapseAll') : t('contextTooltips.diff.expandAll')}
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {changeRequestReview && reviewProvider ? (
                        <ReviewSubmitButton
                            review={changeRequestReview}
                            provider={reviewProvider}
                            className="diff-toolbar__review-button"
                            labelClassName="diff-toolbar__review-label"
                        />
                    ) : null}
                    {changedFiles.length > 0 && showReviewAction && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex flex-shrink-0">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setReviewDialogOpen(true)}
                                        disabled={reviewFlowSubmitting}
                                        className="diff-toolbar__review-button h-7 flex-shrink-0 gap-1.5 px-2"
                                        aria-label={t('diffView.actions.reviewAria')}
                                    >
                                        {reviewFlowSubmitting
                                            ? <Icon name="loader-4" className="size-4 animate-spin" />
                                            : <Icon name="search-eye" className="size-4 text-[var(--primary-text)]" />}
                                        <span className="diff-toolbar__review-label typography-ui-label">{t('chat.work.reviewHint.aiReview')}</span>
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.review')}</TooltipContent>
                        </Tooltip>
                    )}
                    {showWalkthroughButton && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={openWalkthrough}
                                    className="diff-toolbar__walkthrough-button h-7 flex-shrink-0 gap-1.5 px-2"
                                    aria-label={t('walkthrough.action.open')}
                                >
                                    <Icon name="route" className="size-4" />
                                    <span className="diff-toolbar__walkthrough-label typography-ui-label">{t('walkthrough.action.open')}</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.walkthrough')}</TooltipContent>
                        </Tooltip>
                    )}
                </DiffViewToolbar>
                <ReviewFlowDialog
                    open={reviewDialogOpen}
                    onOpenChange={setReviewDialogOpen}
                    projectDirectory={effectiveDirectory ?? null}
                    submitting={reviewFlowSubmitting}
                    onConfirm={handleStartReviewFlow}
                />
                {renderContent()}
            </div>
        </ChangeRequestReviewContext.Provider>
    );
};
