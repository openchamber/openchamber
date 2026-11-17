import React from 'react';
import { ChangeRequestDiffUnavailable } from '@/components/views/git/ChangeRequestDiffUnavailable';
import { GitRepositoryUnreadableState } from '@/components/views/git/GitRepositoryUnreadableState';
import { branchRefLabel } from '@/components/views/git/baseBranch';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useDiffViewSetup } from './useDiffViewSetup';
import { useDiffViewComparisons } from './useDiffViewComparisons';


type DiffViewContentProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'effectiveDirectory' | 't' | 'activeDiffScope' | 'unreadable' | 'isLoadingStatus' | 'status' | 'isGitRepo' |
    'binding' | 'pendingTurnDiffFile' | 'currentSessionId'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'prComparison' | 'selectedPr' | 'comparison' | 'prChangeRequestTerm' | 'commitFilesError' | 'selectedCommitHash' |
    'commitComparison' | 'commitFiles' | 'isBranchBaseResolved' | 'qualifiedBranchBase' | 'branchFilesError' |
    'branchFiles' | 'turnDiffError' | 'retryTurnDiff' | 'turnDiffLoaded' | 'changedFiles'
> & { renderStackedDiffView: () => React.ReactNode };

    export function DiffViewContent({ effectiveDirectory, t, activeDiffScope, unreadable, isLoadingStatus, status, isGitRepo, prComparison, selectedPr, comparison, prChangeRequestTerm, commitFilesError, selectedCommitHash, commitComparison, commitFiles, binding, isBranchBaseResolved, qualifiedBranchBase, branchFilesError, branchFiles, turnDiffError, retryTurnDiff, turnDiffLoaded, pendingTurnDiffFile, currentSessionId, changedFiles, renderStackedDiffView }: DiffViewContentProps) {

        if (!effectiveDirectory) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('diffView.state.selectSessionDirectory')}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && unreadable) {
            return <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />;
        }

        if (activeDiffScope !== 'turn' && isLoadingStatus && !status) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.state.loadingRepositoryStatus')}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && isGitRepo === false) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('diffView.state.notGitRepository')}
                </div>
            );
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
            // A base not found while the status or the binding (whose pull
            // request names it) still load is still being resolved, not missing.
            const baseInputsLoading = status === null || binding.status === 'idle' || binding.status === 'loading';
            if (!isBranchBaseResolved || (!qualifiedBranchBase && baseInputsLoading)) {
                return (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('diffView.branch.resolvingBase')}
                    </div>
                );
            }

            if (!qualifiedBranchBase) {
                return (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="git-branch" className="size-6 text-muted-foreground" />
                        <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.noBaseTitle')}</div>
                        <div className="max-w-sm typography-micro text-muted-foreground">{t('gitView.pr.toast.baseBranchRequired')}</div>
                    </div>
                );
            }

            if (branchFilesError) {
                return (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.loadError')}</div>
                        <div className="max-w-sm typography-micro text-muted-foreground">{branchFilesError}</div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void comparison.refresh()}
                        >
                            {t('diffView.actions.retry')}
                        </Button>
                    </div>
                );
            }

            if (branchFiles === null) {
                return (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('diffView.branch.loadingFiles')}
                    </div>
                );
            }
        }

        if (activeDiffScope === 'turn' && turnDiffError) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                    <div className="typography-ui-label font-semibold text-foreground">{t('diffView.state.failedToLoadDiff')}</div>
                    <div className="typography-meta max-w-[32rem] text-center">{turnDiffError}</div>
                    <button type="button" className="typography-ui-label text-primary hover:underline" onClick={retryTurnDiff}>
                        {t('diffView.actions.retry')}
                    </button>
                </div>
            );
        }

        if (activeDiffScope === 'turn' && (!turnDiffLoaded || pendingTurnDiffFile) && currentSessionId) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.state.loadingChanges')}
                </div>
            );
        }

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {activeDiffScope === 'turn' ? t('diffView.state.noLastTurnChanges')
                        : activeDiffScope === 'pr' ? t('walkthrough.blocked.emptyDiff.description')
                        : activeDiffScope === 'commit' ? t('commitComparison.emptyDiff')
                        : activeDiffScope === 'branch' && qualifiedBranchBase ? t('diffView.branch.empty', { base: branchRefLabel(qualifiedBranchBase) })
                        : t('diffView.state.cleanWorkingTree')}
                </div>
            );
        }

        return renderStackedDiffView();
    }
