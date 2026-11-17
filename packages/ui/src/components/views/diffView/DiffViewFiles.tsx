import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DiffFindBar } from '../diffFind/DiffFindBar';
import type { FileEntry } from './types';
import { EMPTY_COMPARISON_DIFF, isFindRevealFor } from './diffData';
import { FileList, FileTree } from './DiffFileNavigation';
import { MultiFileDiffEntry } from './MultiFileDiffEntry';
import { useDiffViewSetup } from './useDiffViewSetup';
import { useDiffViewComparisons } from './useDiffViewComparisons';
import { useDiffViewStackedViewport } from './useDiffViewStackedViewport';
import { useDiffViewNavigation } from './useDiffViewNavigation';
import { useDiffViewScrollAlignment } from './useDiffViewScrollAlignment';
import { useDiffViewTreeLayout } from './useDiffViewTreeLayout';
import { useDiffViewFind } from './useDiffViewFind';
import { useDiffViewEditor } from './useDiffViewEditor';


type DiffViewFilesProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'effectiveDirectory' | 'expandedFiles' | 'diffWrapLines' | 'diffHideWhitespace' | 'mountedStackedFiles' |
    'pinnedStackedTarget' | 'activeDiffScope' | 'foreign' | 'workingTreeRevision' | 'fileDiffRefreshNonce' | 't' |
    'showFileSidebar' | 'diffScrollRef'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'selectedPr' | 'comparisonDiffData' | 'commentOrigin' | 'loadFullComparisonDiff' | 'lastTurnDiffData' |
    'changedFiles'
> & Pick<ReturnType<typeof useDiffViewStackedViewport>,
    'getLayoutForFile'
> & Pick<ReturnType<typeof useDiffViewNavigation>,
    'handleStackedEntryExpandedChange' | 'registerSectionRef'
> & Pick<ReturnType<typeof useDiffViewScrollAlignment>,
    'handleSelectFile' | 'getFileStaged'
> & Pick<ReturnType<typeof useDiffViewTreeLayout>,
    'fileTreeLayoutRef' | 'isTreeMode' | 'fileTreeWidth' | 'treeSelectedFile' | 'handleSelectFileAndScroll' |
    'handleFileTreeResizeStart' | 'handleFileTreeResizeKey' | 'draggingFileTree' | 'stackedEntriesPending' |
    'stackedEntryCount'
> & Pick<ReturnType<typeof useDiffViewFind>,
    'registerViewerRef' | 'handleFindWordRequest' | 'handleFullContextChange' | 'findReveal' | 'diffFind' |
    'findFocusNonce'
> & Pick<ReturnType<typeof useDiffViewEditor>,
    'openingEditorFilePath' | 'handleOpenInEditor' | 'handleRetryComparisonDiff'
> & {
    visible: boolean;
    showOpenInEditorAction: boolean;
    flushContent: boolean;
};

    export function DiffViewFiles({ effectiveDirectory, expandedFiles, visible, getLayoutForFile, diffWrapLines, diffHideWhitespace, mountedStackedFiles, pinnedStackedTarget, handleSelectFile, handleStackedEntryExpandedChange, registerSectionRef, registerViewerRef, handleFindWordRequest, handleFullContextChange, findReveal, showOpenInEditorAction, activeDiffScope, foreign, selectedPr, openingEditorFilePath, handleOpenInEditor, getFileStaged, workingTreeRevision, fileDiffRefreshNonce, comparisonDiffData, commentOrigin, handleRetryComparisonDiff, loadFullComparisonDiff, lastTurnDiffData, fileTreeLayoutRef, flushContent, isTreeMode, fileTreeWidth, changedFiles, treeSelectedFile, handleSelectFileAndScroll, t, handleFileTreeResizeStart, handleFileTreeResizeKey, draggingFileTree, showFileSidebar, diffFind, findFocusNonce, diffScrollRef, stackedEntriesPending, stackedEntryCount }: DiffViewFilesProps) {
        if (!effectiveDirectory) return null;
        const renderEntry = (file: FileEntry, isSingleFile = false) => {
            const isExpanded = isSingleFile || expandedFiles.has(file.path);
            return (
            <MultiFileDiffEntry
                // Only an expanded entry loads while shown; a collapsed one
                // stays out of the re-render when the view is shown or hidden.
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
                registerSectionRef={registerSectionRef}
                registerViewerRef={registerViewerRef}
                onFindWordRequest={handleFindWordRequest}
                onFullContextChange={handleFullContextChange}
                findReveal={findReveal && isFindRevealFor(file.path, findReveal.key) ? findReveal : null}
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
                initialDiffData={
                    activeDiffScope === 'turn'
                        ? lastTurnDiffData.get(file.path) ?? null
                        : null
                }
            />
            );
        };

        return (
            <div ref={fileTreeLayoutRef} className={cn('flex min-w-0 flex-1 min-h-0 h-full', flushContent ? 'gap-0' : 'gap-3 px-3 pb-3 pt-2')}>
                {isTreeMode && (
                    <>
                        {/* Clamped by CSS too: a width stored in a wide panel must not swallow a narrow one. */}
                        <section
                            className="flex max-w-[50%] flex-shrink-0 flex-col"
                            style={{ width: `${fileTreeWidth}px` }}
                        >
                            <FileTree
                                changedFiles={changedFiles}
                                selectedFile={treeSelectedFile?.path ?? null}
                                onSelectFile={handleSelectFileAndScroll}
                            />
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
                        <FileList
                            changedFiles={changedFiles}
                            selectedFile={null}
                            onSelectFile={handleSelectFileAndScroll}
                        />
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
                        className="[overflow-anchor:none]"
                        disableHorizontal
                        observeMutations={false}
                        preventOverscroll
                        data-diff-virtual-root
                    >
                        {/* The end space is the content's: padding on the scroller would hold a diff's sticky scrollbar that far above the panel's bottom. */}
                        <div className="flex flex-col [overflow-anchor:none] pb-16" data-diff-virtual-content>
                            {isTreeMode
                                ? treeSelectedFile && renderEntry(treeSelectedFile, true)
                                : (stackedEntriesPending ? changedFiles.slice(0, stackedEntryCount) : changedFiles).map((file) => renderEntry(file))}
                        </div>
                    </ScrollableOverlay>
                </div>
            </div>
        );
    }
