import React from 'react';
import { useCommitComparison } from '@/hooks/useCommitComparison';
import { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import { useGitComparison, type GitComparisonSource } from '@/hooks/useGitComparison';
import { useGitStore } from '@/stores/useGitStore';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useBranchComparisonBase } from '@/hooks/useBranchComparisonBase';
import { useBranchPullRequestRequest } from '@/hooks/useBranchPullRequestRequest';
import {
    branchPathRevisions, coerceDiffScope, isBranchScopeAvailable, isBranchScopeDefinitelyUnavailable, useRangeKeyedCache,
    useBoundedDirectoryRetry,
} from '../branchDiffScope';
import { statusToGitCode } from '../turnSnapshotDiff';
import { isDocumentVersions } from '../files/documentVersions';
import { isOfficePreviewFile } from '@/lib/toolHelpers';
import { useComparisonReview } from '@/components/review/useChangeRequestReview';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useLastTurnDiff } from '../useLastTurnDiff';
import { parseDiffFromFile } from '@pierre/diffs';
import { diffCommentOriginFromSource } from '@/lib/diffCommentOrigin';
import type { FileEntry, DiffData, DiffScope, ComparisonDiffResult, DiffViewProps } from './types';
import { EMPTY_COMPARISON_DIFF, isNewStatusFile, isStagedStatusFile, isWorkingStatusFile, createTextDiffDataFromPatch } from './diffData';
import { FULL_CONTEXT_DIFF_LINES, DEFAULT_CONTEXT_DIFF_LINES } from './diffContextLines';
import type { GitAPI, GitStatus } from '@/lib/api/types';
import type { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import type { useI18n } from '@/lib/i18n';

const BRANCH_METADATA_MAX_ATTEMPTS = 3;

interface DiffViewComparisonsOptions {
    currentSessionId: string | null;
    rootDirectory: string | undefined;
    activeDiffScope: DiffScope;
    status: GitStatus | null;
    effectiveDirectory: string | undefined;
    binding: ReturnType<typeof useRepositoryBinding>;
    setActiveDiffScope: React.Dispatch<React.SetStateAction<DiffScope>>;
    fetchBranches: ReturnType<typeof useGitStore.getState>['fetchBranches'];
    git: GitAPI;
    isGitRepo: boolean | null;
    expandedFiles: Set<string>;
    t: ReturnType<typeof useI18n>['t'];
    visible: boolean;
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
    diffScope: DiffScope | null;
}

export function useDiffViewComparisons({
    currentSessionId, rootDirectory, visible, activeDiffScope, status, effectiveDirectory, binding, setActiveDiffScope,
    onDiffScopeChange, fetchBranches, git, isGitRepo, diffScope, expandedFiles, t,
}: DiffViewComparisonsOptions) {
    const {
        diffs: lastTurnDiffs,
        count: turnFileCount,
        loaded: turnDiffLoaded,
        settled: turnDiffSettled,
        error: turnDiffError,
        retry: retryTurnDiff,
    } = useLastTurnDiff(currentSessionId, rootDirectory ?? undefined, { enabled: visible, live: activeDiffScope === 'turn' });

    const lastTurnDiffData = React.useMemo(() => {
        const map = new Map<string, DiffData>();
        for (const diff of lastTurnDiffs) {
            if (!diff.file) continue;
            if (typeof diff.patch === 'string') {
                map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
                continue;
            }
            map.set(diff.file, {
                original: diff.before ?? '',
                modified: diff.after ?? '',
                contextMode: 'full',
            });
        }
        return map;
    }, [lastTurnDiffs]);

    const workingFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isWorkingStatusFile).length;
    }, [status]);

    const stagedFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isStagedStatusFile).length;
    }, [status]);

    const currentBranch = status?.current ?? null;
    const requestedPr = usePullRequestSelectionStore((state) => (effectiveDirectory ? state.diffRequests.get(effectiveDirectory) : undefined));
    const prComparison = usePullRequestComparison(effectiveDirectory ?? null, currentBranch, binding.contexts[0] ?? null, visible && activeDiffScope === 'pr' && !isVSCodeRuntime(), requestedPr);
    const pullRequestContext = prComparison.readContext;
    const selectedPr = prComparison.selectedSource;
    const prChangeRequestTerm = useChangeRequestTerm(prComparison.provider);
    React.useEffect(() => {
        if (!effectiveDirectory || !requestedPr || !status || selectedPr !== requestedPr) return;
        usePullRequestSelectionStore.getState().settleDiffRequest(effectiveDirectory, requestedPr);
    }, [effectiveDirectory, requestedPr, selectedPr, status]);
    const commitComparison = useCommitComparison(effectiveDirectory ?? null, currentBranch, visible && activeDiffScope === 'commit' && !isVSCodeRuntime());
    const selectedCommitHash = commitComparison.selectedCommit?.hash ?? null;
    React.useEffect(() => {
        if ((activeDiffScope === 'commit' || activeDiffScope === 'pr') && isVSCodeRuntime()) {
            setActiveDiffScope('working');
            onDiffScopeChange?.('working');
        }
    }, [activeDiffScope, onDiffScopeChange]);
    const branches = useGitStore((state) => (effectiveDirectory ? state.directories.get(effectiveDirectory)?.branches ?? null : null));
    const isLoadingBranches = useGitStore((state) => (effectiveDirectory ? state.directories.get(effectiveDirectory)?.isLoadingBranches ?? false : false));

    const startBranchMetadataFetch = React.useCallback(() => {
        if (effectiveDirectory) {
            void fetchBranches(effectiveDirectory, git);
        }
    }, [effectiveDirectory, fetchBranches, git]);
    const branchMetadataExhausted = useBoundedDirectoryRetry(
        effectiveDirectory ?? null,
        visible && isGitRepo !== false,
        isLoadingBranches,
        Boolean(branches),
        startBranchMetadataFetch,
        BRANCH_METADATA_MAX_ATTEMPTS
    );

    const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
    const clearBaseOverride = useGitBaseBranchStore((state) => state.clearOverride);
    const remoteNames = React.useMemo(
        () => new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
        [binding.read]
    );
    const { base: qualifiedBranchBase, source: branchBaseSource, resolved: isBranchBaseResolved, revision: branchRevision } = useBranchComparisonBase(
        effectiveDirectory ?? null,
        currentBranch,
        visible && !isVSCodeRuntime() && isGitRepo !== false,
        { branches, remoteNames, primaryRemote: binding.contexts[0]?.primaryRemote, readContext: binding.contexts[0] ?? null },
    );
    const asksBranchPullRequest = visible && !isVSCodeRuntime() && isGitRepo !== false;
    useBranchPullRequestRequest(asksBranchPullRequest ? effectiveDirectory ?? null : null, asksBranchPullRequest ? currentBranch : null, binding);
    const showBranchOption = !isVSCodeRuntime() && isBranchScopeAvailable(currentBranch, qualifiedBranchBase);
    React.useEffect(() => {
        if (diffScope === null && showBranchOption) setActiveDiffScope('branch');
    }, [diffScope, showBranchOption]);
    const isBranchStatusResolved = status !== null;
    const branchScopeDefinitelyUnavailable = isVSCodeRuntime()
        || isGitRepo === false
        || branchMetadataExhausted
        || isBranchScopeDefinitelyUnavailable(
            currentBranch,
            qualifiedBranchBase,
            isBranchStatusResolved,
            isBranchBaseResolved && binding.status === 'ready'
        );
    const [comparisonRetryRevision, setComparisonRetryRevision] = React.useState(0);

    React.useEffect(() => {
        const coercedScope = coerceDiffScope(activeDiffScope, !branchScopeDefinitelyUnavailable);
        if (coercedScope !== activeDiffScope) {
            setActiveDiffScope(coercedScope);
            if (coercedScope === 'working' && diffScope !== null) {
                onDiffScopeChange?.('working');
            }
        }
    }, [activeDiffScope, branchScopeDefinitelyUnavailable, diffScope, onDiffScopeChange]);

    const comparisonSource = React.useMemo<GitComparisonSource | null>(() => {
        if (activeDiffScope === 'pr') return prComparison.diffUnavailable ? null : selectedPr;
        if (activeDiffScope === 'commit' && selectedCommitHash) return { kind: 'commit', hash: selectedCommitHash };
        if (activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch) {
            return { kind: 'branch', baseRef: qualifiedBranchBase, headRef: currentBranch };
        }
        return null;
    }, [activeDiffScope, qualifiedBranchBase, currentBranch, selectedCommitHash, selectedPr, prComparison.diffUnavailable]);
    const selectedPrHead = selectedPr ? prComparison.prs.find((pr) => pr.number === selectedPr.number)?.headSha : undefined;
    const commentOrigin = React.useMemo(
        () => diffCommentOriginFromSource(comparisonSource, { provider: prComparison.provider, revision: selectedPrHead }),
        [comparisonSource, prComparison.provider, selectedPrHead],
    );
    const {
        review: changeRequestReview, provider: reviewProvider,
    } = useComparisonReview(prComparison, effectiveDirectory, visible && activeDiffScope === 'pr' && !isVSCodeRuntime());
    const comparison = useGitComparison(effectiveDirectory ?? null, comparisonSource, visible && !isVSCodeRuntime(), activeDiffScope === 'branch' ? branchRevision : '', prComparison.readContext, prComparison.provider);
    const { fetchDiff: loadComparisonDiff, fetchFullFile: loadComparisonFullFile, fetchVersions: loadComparisonVersions } = comparison;
    const commitFiles = activeDiffScope === 'commit' ? comparison.files : null;
    const commitFilesError = activeDiffScope === 'commit' ? comparison.error : null;
    const branchFiles = activeDiffScope === 'branch' ? comparison.files : null;
    const branchFilesError = activeDiffScope === 'branch' ? comparison.error : null;

    const comparisonRangeKey = comparison.files ? (activeDiffScope === 'pr'
        ? JSON.stringify([comparison.key, comparison.revision]) : comparison.key) : null;
    const comparisonPathsKey = React.useMemo(
        () => (activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr' ? Array.from(expandedFiles).sort().join('\0') : ''),
        [activeDiffScope, expandedFiles]
    );

    const fetchComparisonDiffEntry = React.useCallback(
        async (filePath: string, fullContext = false): Promise<ComparisonDiffResult> => {
            try {
                if (isOfficePreviewFile(filePath)) {
                    const versions = await loadComparisonVersions(filePath);
                    return {
                        status: 'ready',
                        data: isDocumentVersions(versions.original, versions.modified)
                            ? { ...versions, contextMode: 'full' }
                            : { original: '', modified: '', isBinary: true, contextMode: 'full' },
                    };
                }
                const response = await loadComparisonDiff(filePath, fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES);
                return { status: 'ready', data: createTextDiffDataFromPatch(filePath, response.diff, fullContext ? 'full' : 'patch') };
            } catch (error) {
                return { status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') };
            }
        },
        [loadComparisonDiff, loadComparisonVersions, t]
    );
    const fetchComparisonFullFileEntry = React.useCallback(
        async (filePath: string): Promise<ComparisonDiffResult> => {
            try {
                if (isOfficePreviewFile(filePath)) return await fetchComparisonDiffEntry(filePath);
                const { original, modified } = await loadComparisonFullFile(filePath);
                const fileDiff = parseDiffFromFile({ name: filePath, contents: original }, { name: filePath, contents: modified });
                return { status: 'ready', data: { original, modified, fileDiff, contextMode: 'full' } };
            } catch (error) {
                return { status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') };
            }
        },
        [fetchComparisonDiffEntry, loadComparisonFullFile, t]
    );
    const loadFullComparisonDiff = React.useMemo(
        () => activeDiffScope === 'branch' || activeDiffScope === 'commit'
            ? (filePath: string) => fetchComparisonDiffEntry(filePath, true)
            : activeDiffScope === 'pr'
            ? fetchComparisonFullFileEntry
            : undefined,
        [activeDiffScope, fetchComparisonDiffEntry, fetchComparisonFullFileEntry]
    );

    const branchDiffRevisions = React.useMemo(
        () => activeDiffScope === 'branch' ? branchPathRevisions(branchFiles, branchRevision) : undefined,
        [activeDiffScope, branchFiles, branchRevision]
    );
    const comparisonDiffData = useRangeKeyedCache<ComparisonDiffResult>(
        comparisonRangeKey,
        visible ? comparisonPathsKey : '',
        comparisonRangeKey ? fetchComparisonDiffEntry : null,
        EMPTY_COMPARISON_DIFF,
        JSON.stringify([activeDiffScope === 'pr' ? comparison.revision : 0, comparisonRetryRevision]),
        branchDiffRevisions
    );

    const branchFileCount = branchFiles?.length ?? null;

    const changedFiles: FileEntry[] = React.useMemo(() => {
        if (activeDiffScope === 'commit' || activeDiffScope === 'pr') {
            return (comparison.files ?? []).map((file) => ({
                path: file.path, index: '', working_dir: file.status, previousPath: file.previousPath,
                insertions: file.insertions, deletions: file.deletions, isNew: file.status === 'A',
            }));
        }
        if (activeDiffScope === 'branch') {
            return (branchFiles ?? [])
                .map((file) => ({
                    path: file.path,
                    index: '',
                    working_dir: file.status,
                    previousPath: file.previousPath,
                    insertions: 0,
                    deletions: 0,
                    isNew: file.status === 'A',
                }))
                .sort((a, b) => a.path.localeCompare(b.path));
        }

        if (activeDiffScope === 'turn') {
            return lastTurnDiffs
                .map((diff) => ({
                    path: diff.file ?? '',
                    index: '',
                    working_dir: statusToGitCode(diff.status),
                    insertions: diff.additions ?? 0,
                    deletions: diff.deletions ?? 0,
                    isNew: diff.status === 'added',
                }))
                .filter((file) => file.path)
                .sort((a, b) => a.path.localeCompare(b.path));
        }

        if (!status?.files) return [];
        const diffStats = status.diffStats;
        const includeFile = activeDiffScope === 'staged'
            ? isStagedStatusFile
            : activeDiffScope === 'working'
                ? isWorkingStatusFile
                : () => true;

        const statsForFile = (filePath: string): { insertions: number; deletions: number } => {
            const staged = diffStats?.staged?.[filePath];
            const working = diffStats?.working?.[filePath];
            if (activeDiffScope === 'staged') {
                return { insertions: staged?.insertions ?? 0, deletions: staged?.deletions ?? 0 };
            }
            if (activeDiffScope === 'working') {
                return { insertions: working?.insertions ?? 0, deletions: working?.deletions ?? 0 };
            }
            return {
                insertions: (staged?.insertions ?? 0) + (working?.insertions ?? 0),
                deletions: (staged?.deletions ?? 0) + (working?.deletions ?? 0),
            };
        };

        return status.files
            .filter(includeFile)
            .map((file) => {
                const stats = statsForFile(file.path);
                return {
                    ...file,
                    insertions: stats.insertions,
                    deletions: stats.deletions,
                    isNew: isNewStatusFile(file),
                };
            })
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [activeDiffScope, branchFiles, comparison.files, lastTurnDiffs, status]);

    const changedFilePathsKey = React.useMemo(
        () => changedFiles.map((file) => file.path).join('\0'),
        [changedFiles],
    );

    return {
        lastTurnDiffs, turnFileCount, turnDiffLoaded, turnDiffSettled, turnDiffError, retryTurnDiff, lastTurnDiffData,
        workingFileCount, stagedFileCount, currentBranch, prComparison, pullRequestContext, selectedPr,
        prChangeRequestTerm, commitComparison, selectedCommitHash, branches, setBaseOverride, clearBaseOverride,
        qualifiedBranchBase, branchBaseSource, isBranchBaseResolved, showBranchOption, setComparisonRetryRevision,
        commentOrigin, changeRequestReview, reviewProvider, comparison, commitFiles, commitFilesError, branchFiles,
        branchFilesError, fetchComparisonDiffEntry, loadFullComparisonDiff, comparisonDiffData, branchFileCount,
        changedFiles, changedFilePathsKey,
    };
}
