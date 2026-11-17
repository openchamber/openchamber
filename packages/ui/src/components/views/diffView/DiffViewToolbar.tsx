import { PullRequestComparisonSelector } from '@/components/views/git/PullRequestComparisonSelector';
import { ChangeScopeSelector } from '../ChangeScopeSelector';
import { CommitComparisonSelector } from '@/components/views/git/CommitComparisonSelector';
import { NestedRepoPicker } from '@/components/views/git/NestedRepoPicker';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { BranchComparisonSelector } from '@/components/views/git/BranchComparisonSelector';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { ToolbarButton } from '@/components/ui/action-toolbar';
import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import { isVSCodeRuntime } from '@/lib/desktop';
import { type WalkthroughTarget } from '@/lib/walkthrough/types';
import { type DiffToolbarMenuOption, useDiffViewSetup } from './useDiffViewSetup';
import type { DiffViewProps } from './types';
import { useDiffViewComparisons } from './useDiffViewComparisons';
import { useDiffViewStackedViewport } from './useDiffViewStackedViewport';
import { useDiffViewNavigation } from './useDiffViewNavigation';
import { useDiffViewReview } from './useDiffViewReview';
import { useDiffViewEditor } from './useDiffViewEditor';


type DiffViewToolbarProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'showWalkthroughAction' | 'activeDiffScope' | 'effectiveDirectory' | 'requestWalkthroughTarget' | 'foreign' |
    'panelDirectory' | 'openContextPanelTab' | 'rootDirectory' | 'openContextSurface' | 't' | 'isMobileLayout' |
    'diffFileListMode' | 'setDiffFileListMode' | 'diffWrapLines' | 'setDiffWrapLines' | 'diffWrapLinesStore' |
    'diffHideWhitespace' | 'setDiffHideWhitespace' | 'toolbarRef' | 'inPanelHeader' | 'repositoryOptions' |
    'nestedGitDirectory' | 'selectNestedRepo' | 'isMobile' | 'setActiveDiffScope' | 'isLoadingStatus' | 'status' |
    'binding' | 'runtimeKey' | 'expandedFiles' | 'showReviewAction' | 'setReviewDialogOpen' |
    'handleToolbarMenuOpenChange' | 'toolbarMenuOptions'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'changedFiles' | 'pullRequestContext' | 'selectedCommitHash' | 'qualifiedBranchBase' | 'currentBranch' |
    'selectedPr' | 'workingFileCount' | 'stagedFileCount' | 'turnFileCount' | 'branchFileCount' | 'commitFiles' |
    'comparison' | 'showBranchOption' | 'prChangeRequestTerm' | 'branches' | 'branchBaseSource' | 'setBaseOverride' |
    'clearBaseOverride' | 'commitComparison' | 'prComparison' | 'changeRequestReview' | 'reviewProvider'
> & Pick<ReturnType<typeof useDiffViewStackedViewport>,
    'currentLayoutForAllFiles'
> & Pick<ReturnType<typeof useDiffViewNavigation>,
    'handleExpandOrCollapseAll'
> & Pick<ReturnType<typeof useDiffViewReview>,
    'reviewFlowSubmitting'
> & Pick<ReturnType<typeof useDiffViewEditor>,
    'handleHeaderLayoutChange'
> & {
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
};

export function DiffViewToolbar({
    changedFiles, showWalkthroughAction, activeDiffScope, pullRequestContext, effectiveDirectory, selectedCommitHash,
    qualifiedBranchBase, currentBranch, requestWalkthroughTarget, selectedPr, foreign, panelDirectory,
    openContextPanelTab, rootDirectory, openContextSurface, t, isMobileLayout, diffFileListMode, setDiffFileListMode,
    diffWrapLines, setDiffWrapLines, diffWrapLinesStore, diffHideWhitespace, setDiffHideWhitespace,
    currentLayoutForAllFiles, handleHeaderLayoutChange, toolbarRef, inPanelHeader, repositoryOptions, nestedGitDirectory,
    selectNestedRepo, isMobile, workingFileCount, stagedFileCount, turnFileCount, branchFileCount, commitFiles,
    comparison, showBranchOption, prChangeRequestTerm, setActiveDiffScope, onDiffScopeChange, isLoadingStatus, status,
    branches, binding, branchBaseSource, setBaseOverride, clearBaseOverride, commitComparison, runtimeKey, prComparison,
    handleExpandOrCollapseAll, expandedFiles, changeRequestReview, reviewProvider, showReviewAction, setReviewDialogOpen,
    reviewFlowSubmitting, handleToolbarMenuOpenChange, toolbarMenuOptions,
}: DiffViewToolbarProps) {
    const showWalkthroughButton = changedFiles.length > 0 && showWalkthroughAction && (activeDiffScope !== 'pr' || Boolean(pullRequestContext));
    const openWalkthrough = () => {
        // Carry the scope across: opening the walkthrough
        // while looking at staged changes should review
        // staged changes, not whatever the panel showed last.
        const directory = effectiveDirectory ?? '';
        const localSource: WalkthroughTarget = {
            source: activeDiffScope === 'commit' && selectedCommitHash ? {
                kind: 'commit', hash: selectedCommitHash,
            } : activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch ? {
                kind: 'branch',
                baseRef: qualifiedBranchBase,
                headRef: currentBranch,
            } : {
                kind: 'working-tree',
                scope: activeDiffScope === 'staged' || activeDiffScope === 'working'
                    ? activeDiffScope
                    : 'all',
            },
        };
        requestWalkthroughTarget(directory, activeDiffScope === 'pr' && selectedPr && pullRequestContext
            ? { source: selectedPr, context: pullRequestContext }
            : localSource);
        if (foreign && panelDirectory) openContextPanelTab(panelDirectory, { mode: 'walkthrough', targetDirectory: rootDirectory });
        else openContextSurface(rootDirectory ?? directory, 'walkthrough');
    };

    // A control moved into "More actions" as a menu item; a view option shows
    // a check while it is on. Null when the row does not show that control.
    const toolbarMenuItem = (option: DiffToolbarMenuOption) => {
        switch (option) {
            case 'walkthrough':
                if (!showWalkthroughButton) return null;
                return { label: t('walkthrough.action.open'), icon: <Icon name="route" className="size-4" />, on: false, select: openWalkthrough };
            case 'tree':
                if (isMobileLayout) return null;
                return {
                    label: t('diffView.fileTree.showAsTree'),
                    icon: <Icon name="node-tree" className="size-4" />,
                    on: diffFileListMode === 'tree',
                    select: () => setDiffFileListMode(diffFileListMode === 'tree' ? 'flat' : 'tree'),
                };
            case 'wrap':
                return { label: t('diffView.actions.wrapLines'), icon: <Icon name="text-wrap" className="size-4" />, on: diffWrapLines, select: () => setDiffWrapLines(!diffWrapLinesStore) };
            case 'whitespace':
                return {
                    label: t('diffView.actions.hideWhitespace'),
                    icon: <Icon name="space" className="size-4" />,
                    on: diffHideWhitespace,
                    select: () => setDiffHideWhitespace(!diffHideWhitespace),
                };
            case 'layout': {
                if (!currentLayoutForAllFiles) return null;
                const sideBySide = currentLayoutForAllFiles === 'side-by-side';
                return {
                    label: t('diffView.layout.sideBySide'),
                    icon: <Icon name="layout-column" className="size-4" />,
                    on: sideBySide,
                    select: () => handleHeaderLayoutChange(sideBySide ? 'unified' : 'side-by-side'),
                };
            }
        }
    };
return (
            <ContextPanelHeaderToolbar>
            <div ref={toolbarRef} className={cn('flex min-w-0 items-center gap-2', inPanelHeader ? 'flex-1 py-1 pe-1' : 'px-3 py-2 bg-background')}>
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
                            workingCount={workingFileCount}
                            stagedCount={stagedFileCount}
                            turnCount={turnFileCount}
                            branchCount={branchFileCount}
                            commitCount={activeDiffScope === 'commit' ? commitFiles?.length ?? null : null}
                            prCount={activeDiffScope === 'pr' ? comparison.files?.length ?? null : null}
                            showCommitOption={!isVSCodeRuntime()}
                            showBranchOption={showBranchOption}
                            changeRequestTerm={prChangeRequestTerm}
                            onScopeChange={(scope) => {
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
                                <Icon
                                    name="expand-up-down"
                                    className="size-4"
                                />
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
                                {/* A raised button like its neighbours: a filled one read
                                    as a state. The accent stays on its icon. */}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setReviewDialogOpen(true)}
                                    disabled={reviewFlowSubmitting}
                                    className="diff-toolbar__review-button h-7 flex-shrink-0 gap-1.5 px-2"
                                    aria-label={t('diffView.actions.reviewAria')}
                                >
                                    {reviewFlowSubmitting ? (
                                        <Icon name="loader-4" className="size-4 animate-spin" />
                                    ) : (
                                        <Icon name="search-eye" className="size-4 text-[var(--primary-text)]" />
                                    )}
                                    <span className="diff-toolbar__review-label typography-ui-label">
                                        {t('chat.work.reviewHint.aiReview')}
                                    </span>
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
                                <span className="diff-toolbar__walkthrough-label typography-ui-label">
                                    {t('walkthrough.action.open')}
                                </span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.walkthrough')}</TooltipContent>
                    </Tooltip>
                )}
                {changedFiles.length > 0 && (
                    <DropdownMenu onOpenChange={handleToolbarMenuOpenChange}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="diff-toolbar__more flex-shrink-0">
                                    <DropdownMenuTrigger asChild>
                                        <ToolbarButton label={t('diffView.actions.moreActions')} icon="more" />
                                    </DropdownMenuTrigger>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.moreActions')}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="min-w-56">
                            {toolbarMenuOptions.map((option) => {
                                const item = toolbarMenuItem(option);
                                if (!item) return null;
                                return (
                                    <DropdownMenuItem key={option} className="flex items-center gap-2" onClick={item.select}>
                                        {item.icon}
                                        <span className="min-w-0 truncate typography-ui-label text-foreground">{item.label}</span>
                                        {item.on ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
                                    </DropdownMenuItem>
                                );
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
            </ContextPanelHeaderToolbar>
);
}
