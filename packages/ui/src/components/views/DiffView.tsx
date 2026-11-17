import React from 'react';
import type { DiffViewProps } from './diffView/types';
import { ChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { useDiffViewSetup } from './diffView/useDiffViewSetup';
import { useDiffViewComparisons } from './diffView/useDiffViewComparisons';
import { useDiffViewStackedViewport } from './diffView/useDiffViewStackedViewport';
import { useDiffViewRefresh } from './diffView/useDiffViewRefresh';
import { useDiffViewNavigation } from './diffView/useDiffViewNavigation';
import { useDiffViewReview } from './diffView/useDiffViewReview';
import { useDiffViewScrollAlignment } from './diffView/useDiffViewScrollAlignment';
import { useDiffViewTreeLayout } from './diffView/useDiffViewTreeLayout';
import { useDiffViewFind } from './diffView/useDiffViewFind';
import { useDiffViewEditor } from './diffView/useDiffViewEditor';
import { DiffViewFiles } from './diffView/DiffViewFiles';
import { DiffViewContent } from './diffView/DiffViewContent';
import { DiffViewToolbar } from './diffView/DiffViewToolbar';
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

    const {
        t, inPanelHeader, toolbarRef, toolbarMenuOptions, handleToolbarMenuOpenChange, git, files, panelDirectory,
        foreign, rootDirectory, runtimeKey, nestedGitDirectory, rootIsGitRepo, repositoryOptions, repositoriesKnown,
        unreadable, effectiveDirectory, binding, openContextSurface, openContextPanelTab, requestWalkthroughTarget,
        screenWidth, isMobile, isGitRepo, status, isLoadingStatus, setActiveDirectory, ensureStatus, selectNestedRepo,
        fetchStatus, fetchBranches, clearDiffCache, setDiff, displayFile, setDisplayFile, displayFileStaged,
        setDisplayFileStaged, changedFallback, setChangedFallback, fallbackStatusRequestRef, pinnedStackedTarget,
        setPinnedStackedTarget, expandedFiles, setExpandedFiles, mountedStackedFiles, setMountedStackedFiles,
        scrollRequestNonce, setScrollRequestNonce, fileDiffRefreshNonce, setFileDiffRefreshNonce, workingTreeRevision,
        setWorkingTreeRevision, reviewDialogOpen, setReviewDialogOpen, activeDiffScope, setActiveDiffScope,
        pendingDiffFile, pendingDiffStaged, pendingDiffScope, setPendingDiffFile, pendingTurnDiffFile,
        setPendingTurnDiffFile, diffLayoutPreference, diffFileLayout, setDiffLayoutForAllFiles, diffWrapLinesStore,
        setDiffWrapLines, diffHideWhitespace, setDiffHideWhitespace, diffFileListMode, setDiffFileListMode,
        openContextFileAtLine, currentSessionId, diffWrapLines, forcedStaged, activeDiffStaged, isMobileLayout,
        showReviewAction, showWalkthroughAction, showFileSidebar, diffScrollRef, diffRootRef, fileSectionRefs,
        pendingScrollTargetRef, pendingScrollFrameRef, shouldPinAfterAlignRef, visibleSyncFrameRef, stackedStateScopeRef,
        lastScrollAnchorRef, pendingScrollAnchorRestoreRef, captureScrollAnchor, cancelPendingScrollAlignment,
        expandStackedFile } = useDiffViewSetup({ targetDirectory, visible, diffScope, hideStackedFileSidebar,
    });
    const {
        lastTurnDiffs, turnFileCount, turnDiffLoaded, turnDiffSettled, turnDiffError, retryTurnDiff, lastTurnDiffData,
        workingFileCount, stagedFileCount, currentBranch, prComparison, pullRequestContext, selectedPr,
        prChangeRequestTerm, commitComparison, selectedCommitHash, branches, setBaseOverride, clearBaseOverride,
        qualifiedBranchBase, branchBaseSource, isBranchBaseResolved, showBranchOption, setComparisonRetryRevision,
        commentOrigin, changeRequestReview, reviewProvider, comparison, commitFiles, commitFilesError, branchFiles,
        branchFilesError, fetchComparisonDiffEntry, loadFullComparisonDiff, comparisonDiffData, branchFileCount,
        changedFiles, changedFilePathsKey } = useDiffViewComparisons({ currentSessionId, rootDirectory, visible,
        activeDiffScope, status, effectiveDirectory, binding, setActiveDiffScope, onDiffScopeChange, fetchBranches, git,
        isGitRepo, diffScope, expandedFiles, t,
    });
    const {
        queueVisibleStackedFilesSync, queueVisibleStackedFilesSyncRef, getLayoutForFile,
        currentLayoutForAllFiles } = useDiffViewStackedViewport({ changedFilePathsKey, effectiveDirectory,
        activeDiffScope, stackedDefaultCollapsedAll, stackedStateScopeRef, setExpandedFiles, setMountedStackedFiles,
        visibleSyncFrameRef, visible, diffScrollRef, fileSectionRefs, expandedFiles, lastScrollAnchorRef, changedFiles,
        diffFileLayout, diffLayoutPreference, screenWidth,
    });
    useDiffViewRefresh({ visible, effectiveDirectory, setActiveDirectory, ensureStatus, git, runtimeKey, pendingScrollAnchorRestoreRef, captureScrollAnchor, lastScrollAnchorRef, clearDiffCache, setFileDiffRefreshNonce, setWorkingTreeRevision, fetchStatus, diffScrollRef, fileSectionRefs, fileDiffRefreshNonce });
    const {
        registerSectionRef, handleStackedEntryExpandedChange,
        handleExpandOrCollapseAll } = useDiffViewNavigation({ visible, activeDiffScope, pendingDiffScope,
        pendingDiffFile, setActiveDiffScope, setDisplayFile, setDisplayFileStaged, pendingDiffStaged, setPendingDiffFile,
        shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce, targetFilePath,
        pendingTurnDiffFile, diffScope, currentSessionId, setPendingTurnDiffFile, turnDiffSettled, rootDirectory,
        lastTurnDiffs, fallbackStatusRequestRef, setChangedFallback, onDiffScopeChange, changedFallback,
        effectiveDirectory, repositoriesKnown, rootIsGitRepo, repositoryOptions, selectNestedRepo, fetchStatus, git,
        changedFiles, displayFile, fileSectionRefs, queueVisibleStackedFilesSyncRef, cancelPendingScrollAlignment,
        setExpandedFiles, setMountedStackedFiles, queueVisibleStackedFilesSync,
    });
    const { reviewFlowSubmitting, handleStartReviewFlow } = useDiffViewReview({ setReviewDialogOpen, currentSessionId, rootDirectory });
    const {
        scrollToFile, getFileStaged, handleSelectFile } = useDiffViewScrollAlignment({ fileSectionRefs, diffScrollRef,
        forcedStaged, displayFileStaged, displayFile, pendingScrollTargetRef, visible, shouldPinAfterAlignRef,
        setPinnedStackedTarget, pendingScrollFrameRef, pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce,
    });
    const {
        isTreeMode, stackedEntryCount, stackedEntriesPending, fileTreeLayoutRef, draggingFileTree, fileTreeWidth,
        handleFileTreeResizeStart, handleFileTreeResizeKey, treeSelectedFile,
        handleSelectFileAndScroll } = useDiffViewTreeLayout({ diffFileListMode, isMobileLayout, effectiveDirectory,
        activeDiffScope, changedFiles, scrollRequestNonce, displayFile, expandedFiles, expandStackedFile,
        cancelPendingScrollAlignment, setDisplayFile, setDisplayFileStaged, diffScrollRef, shouldPinAfterAlignRef,
        pendingScrollTargetRef, setScrollRequestNonce, scrollToFile, visible,
    });
    const {
        handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest,
        findFocusNonce } = useDiffViewFind({ effectiveDirectory, git, diffHideWhitespace, getFileStaged, activeDiffScope,
        lastTurnDiffData, comparisonDiffData, loadFullComparisonDiff, fetchComparisonDiffEntry, getLayoutForFile,
        changedFiles, workingTreeRevision, fileDiffRefreshNonce, isTreeMode, displayFile, setDisplayFile,
        setDisplayFileStaged, expandStackedFile, scrollToFile, visible, diffRootRef,
    });
    const {
        handleHeaderLayoutChange, openingEditorFilePath, handleOpenInEditor,
        handleRetryComparisonDiff } = useDiffViewEditor({ setDiffLayoutForAllFiles, rootDirectory, effectiveDirectory,
        git, activeDiffStaged, setDiff, files, openContextFileAtLine, setComparisonRetryRevision,
    });
    return (
        <ChangeRequestReviewContext.Provider value={changeRequestReview}>
            <div ref={diffRootRef} data-find-surface="" className="flex h-full flex-col overflow-hidden bg-background">
                <DiffViewToolbar
                    changedFiles={changedFiles}
                    showWalkthroughAction={showWalkthroughAction}
                    activeDiffScope={activeDiffScope}
                    pullRequestContext={pullRequestContext}
                    effectiveDirectory={effectiveDirectory}
                    selectedCommitHash={selectedCommitHash}
                    qualifiedBranchBase={qualifiedBranchBase}
                    currentBranch={currentBranch}
                    requestWalkthroughTarget={requestWalkthroughTarget}
                    selectedPr={selectedPr}
                    foreign={foreign}
                    panelDirectory={panelDirectory}
                    openContextPanelTab={openContextPanelTab}
                    rootDirectory={rootDirectory}
                    openContextSurface={openContextSurface}
                    t={t}
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
                    toolbarRef={toolbarRef}
                    inPanelHeader={inPanelHeader}
                    repositoryOptions={repositoryOptions}
                    nestedGitDirectory={nestedGitDirectory}
                    selectNestedRepo={selectNestedRepo}
                    isMobile={isMobile}
                    workingFileCount={workingFileCount}
                    stagedFileCount={stagedFileCount}
                    turnFileCount={turnFileCount}
                    branchFileCount={branchFileCount}
                    commitFiles={commitFiles}
                    comparison={comparison}
                    showBranchOption={showBranchOption}
                    prChangeRequestTerm={prChangeRequestTerm}
                    setActiveDiffScope={setActiveDiffScope}
                    onDiffScopeChange={onDiffScopeChange}
                    isLoadingStatus={isLoadingStatus}
                    status={status}
                    branches={branches}
                    binding={binding}
                    branchBaseSource={branchBaseSource}
                    setBaseOverride={setBaseOverride}
                    clearBaseOverride={clearBaseOverride}
                    commitComparison={commitComparison}
                    runtimeKey={runtimeKey}
                    prComparison={prComparison}
                    handleExpandOrCollapseAll={handleExpandOrCollapseAll}
                    expandedFiles={expandedFiles}
                    changeRequestReview={changeRequestReview}
                    reviewProvider={reviewProvider}
                    showReviewAction={showReviewAction}
                    setReviewDialogOpen={setReviewDialogOpen}
                    reviewFlowSubmitting={reviewFlowSubmitting}
                    handleToolbarMenuOpenChange={handleToolbarMenuOpenChange}
                    toolbarMenuOptions={toolbarMenuOptions}
                />
                <ReviewFlowDialog
                    open={reviewDialogOpen}
                    onOpenChange={setReviewDialogOpen}
                    projectDirectory={effectiveDirectory ?? null}
                    submitting={reviewFlowSubmitting}
                    onConfirm={handleStartReviewFlow}
                />
                <DiffViewContent
                    effectiveDirectory={effectiveDirectory}
                    t={t}
                    activeDiffScope={activeDiffScope}
                    unreadable={unreadable}
                    isLoadingStatus={isLoadingStatus}
                    status={status}
                    isGitRepo={isGitRepo}
                    prComparison={prComparison}
                    selectedPr={selectedPr}
                    comparison={comparison}
                    prChangeRequestTerm={prChangeRequestTerm}
                    commitFilesError={commitFilesError}
                    selectedCommitHash={selectedCommitHash}
                    commitComparison={commitComparison}
                    commitFiles={commitFiles}
                    binding={binding}
                    isBranchBaseResolved={isBranchBaseResolved}
                    qualifiedBranchBase={qualifiedBranchBase}
                    branchFilesError={branchFilesError}
                    branchFiles={branchFiles}
                    turnDiffError={turnDiffError}
                    retryTurnDiff={retryTurnDiff}
                    turnDiffLoaded={turnDiffLoaded}
                    pendingTurnDiffFile={pendingTurnDiffFile}
                    currentSessionId={currentSessionId}
                    changedFiles={changedFiles}
                    renderStackedDiffView={() => (
                        <DiffViewFiles
                            effectiveDirectory={effectiveDirectory}
                            expandedFiles={expandedFiles}
                            visible={visible}
                            getLayoutForFile={getLayoutForFile}
                            diffWrapLines={diffWrapLines}
                            diffHideWhitespace={diffHideWhitespace}
                            mountedStackedFiles={mountedStackedFiles}
                            pinnedStackedTarget={pinnedStackedTarget}
                            handleSelectFile={handleSelectFile}
                            handleStackedEntryExpandedChange={handleStackedEntryExpandedChange}
                            registerSectionRef={registerSectionRef}
                            registerViewerRef={registerViewerRef}
                            handleFindWordRequest={handleFindWordRequest}
                            handleFullContextChange={handleFullContextChange}
                            findReveal={findReveal}
                            showOpenInEditorAction={showOpenInEditorAction}
                            activeDiffScope={activeDiffScope}
                            foreign={foreign}
                            selectedPr={selectedPr}
                            openingEditorFilePath={openingEditorFilePath}
                            handleOpenInEditor={handleOpenInEditor}
                            getFileStaged={getFileStaged}
                            workingTreeRevision={workingTreeRevision}
                            fileDiffRefreshNonce={fileDiffRefreshNonce}
                            comparisonDiffData={comparisonDiffData}
                            commentOrigin={commentOrigin}
                            handleRetryComparisonDiff={handleRetryComparisonDiff}
                            loadFullComparisonDiff={loadFullComparisonDiff}
                            lastTurnDiffData={lastTurnDiffData}
                            fileTreeLayoutRef={fileTreeLayoutRef}
                            flushContent={flushContent}
                            isTreeMode={isTreeMode}
                            fileTreeWidth={fileTreeWidth}
                            changedFiles={changedFiles}
                            treeSelectedFile={treeSelectedFile}
                            handleSelectFileAndScroll={handleSelectFileAndScroll}
                            t={t}
                            handleFileTreeResizeStart={handleFileTreeResizeStart}
                            handleFileTreeResizeKey={handleFileTreeResizeKey}
                            draggingFileTree={draggingFileTree}
                            showFileSidebar={showFileSidebar}
                            diffFind={diffFind}
                            findFocusNonce={findFocusNonce}
                            diffScrollRef={diffScrollRef}
                            stackedEntriesPending={stackedEntriesPending}
                            stackedEntryCount={stackedEntryCount}
                        />
                    )}
                />
            </div>
        </ChangeRequestReviewContext.Provider>
    );
};
