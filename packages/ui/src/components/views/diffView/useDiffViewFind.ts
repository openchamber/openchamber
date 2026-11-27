import React from 'react';
import { type GitPathDiffBatchEntry } from '@/lib/api/types';
import { GitPathUnavailableError } from '@/lib/api/git-path-diff';
import { hasFileVersionsDiff } from '@/lib/toolHelpers';
import { type FileDiffMetadata } from '@pierre/diffs';
import { resolveFindDiff, useDiffFind, type DiffFindLayout, type DiffFindNestedSources, type DiffFindSource } from '../diffFind/useDiffFind';
import { useDiffFindSurface } from '../diffFind/useDiffFindSurface';
import { createFindDiffBatchReader } from '../diffFind/findDiffBatch';
import type { FileEntry, DiffFindReveal, DiffScope, DiffData, ComparisonDiffResult } from './types';
import {
    isStagedStatusFile, isWorkingStatusFile, toAbsolutePath, createTextDiffDataFromPatch, diffDataToFileDiff,
    comparisonResultDiffData, findPayloadRevision, isFindRevealFor, toNestedFileEntries,
} from './diffData';
import { FULL_CONTEXT_DIFF_LINES, DEFAULT_CONTEXT_DIFF_LINES } from './diffContextLines';
import type { GitAPI } from '@/lib/api/types';

interface DiffViewFindOptions {
    effectiveDirectory: string | undefined;
    git: GitAPI;
    diffHideWhitespace: boolean;
    activeDiffScope: DiffScope;
    workingTreeRevision: number;
    fileDiffRefreshNonce: ReadonlyMap<string, number>;
    displayFile: string | null;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    expandStackedFile: (path: string) => void;
    diffRootRef: React.RefObject<HTMLDivElement | null>;
    lastTurnDiffData: ReadonlyMap<string, DiffData>;
    comparisonDiffData: ReadonlyMap<string, ComparisonDiffResult>;
    comparisonRangeKey: string | null;
    comparisonPathRevisions?: ReadonlyMap<string, string>;
    loadFullComparisonDiff: ((path: string) => Promise<ComparisonDiffResult>) | undefined;
    fetchComparisonDiffEntry: (path: string, fullContext?: boolean) => Promise<ComparisonDiffResult>;
    changedFiles: FileEntry[];
    getLayoutForFile: (file: FileEntry) => 'inline' | 'side-by-side';
    getFileStaged: (path: string) => boolean;
    scrollToFile: (path: string) => void;
    cancelScrollHold: () => void;
    isTreeMode: boolean;
    visible: boolean;
    comparisonKey?: string | null;
    findKeyOf?: (file: FileEntry) => string;
}

const pathAsFindKey = (file: FileEntry) => file.path;

export function useDiffViewFind({
    effectiveDirectory, git, diffHideWhitespace, getFileStaged, activeDiffScope, lastTurnDiffData, comparisonDiffData,
    loadFullComparisonDiff, fetchComparisonDiffEntry, getLayoutForFile, changedFiles, workingTreeRevision,
    fileDiffRefreshNonce, isTreeMode, displayFile, setDisplayFile, setDisplayFileStaged, expandStackedFile, scrollToFile,
    cancelScrollHold, visible, diffRootRef, comparisonKey, comparisonRangeKey, comparisonPathRevisions, findKeyOf = pathAsFindKey,
}: DiffViewFindOptions) {
    const filesByKey = React.useMemo(
        () => new Map(changedFiles.map((file) => [findKeyOf(file), file])),
        [changedFiles, findKeyOf],
    );
    const [findFullContextFiles, setFindFullContextFiles] = React.useState<ReadonlySet<string>>(() => new Set());
    const handleFullContextChange = React.useCallback((path: string, full: boolean) => {
        setFindFullContextFiles((previous) => {
            if (previous.has(path) === full) return previous;
            const next = new Set(previous);
            if (full) next.add(path);
            else next.delete(path);
            return next;
        });
    }, []);

    const readNestedRepositoryForFind = React.useCallback(async (
        rowKey: string,
        rowPath: string,
        layout: DiffFindLayout,
        revision: string,
    ): Promise<DiffFindNestedSources | null> => {
        if (!effectiveDirectory) return null;
        const nestedDirectory = toAbsolutePath(effectiveDirectory, rowPath);
        const status = await git.getGitStatus(nestedDirectory, { fresh: true });
        return {
            nestedSources: toNestedFileEntries(status).map((nestedFile) => ({
                filePath: `${rowKey}${nestedFile.path}`,
                layout,
                revision,
                load: async () => {
                    if (hasFileVersionsDiff(nestedFile.path)) return null;
                    if (!git.getGitDiff) return null;
                    const staged = isStagedStatusFile(nestedFile) && !isWorkingStatusFile(nestedFile);
                    const response = await git.getGitDiff(nestedDirectory, { path: nestedFile.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES, previousPath: nestedFile.previousPath });
                    const data = { ...createTextDiffDataFromPatch(nestedFile.path, response.diff, 'patch'), submodule: response.submodule };
                    return resolveFindDiff(diffDataToFileDiff(nestedFile.path, data), diffHideWhitespace);
                },
            })),
        };
    }, [diffHideWhitespace, effectiveDirectory, git]);

    const [readFindDiffBatch] = React.useState(createFindDiffBatchReader);
    const diffFindSourcesRef = React.useRef<readonly DiffFindSource[]>([]);
    const readBatchedDiffForFind = React.useCallback((
        directory: string,
        filePath: string,
        revision: string,
        staged: boolean,
        fullContext: boolean,
    ): Promise<GitPathDiffBatchEntry | null> => {
        if (!git.getGitDiffs) return Promise.resolve(null);
        const peers = diffFindSourcesRef.current
            .filter((source) => !hasFileVersionsDiff(source.filePath)
                && getFileStaged(source.filePath) === staged
                && findFullContextFiles.has(source.filePath) === fullContext)
            .map((source) => ({ filePath: filesByKey.get(source.filePath)?.path ?? source.filePath, revision: source.revision ?? '' }));
        return readFindDiffBatch({
            directory,
            filePath,
            revision,
            staged,
            contextLines: fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES,
            peers,
            getGitDiffs: (target, options) => git.getGitDiffs?.(target, options) ?? Promise.resolve([]),
        });
    }, [filesByKey, findFullContextFiles, getFileStaged, git, readFindDiffBatch]);

    const loadFileDiffForFind = React.useCallback(async (
        file: FileEntry,
        revision: string,
    ): Promise<FileDiffMetadata | DiffFindNestedSources | null> => {
        const filePath = file.path;
        const findKey = findKeyOf(file);
        const fullContext = findFullContextFiles.has(findKey);
        if (activeDiffScope === 'turn') {
            const data = lastTurnDiffData.get(filePath);
            return resolveFindDiff(data ? diffDataToFileDiff(filePath, data) : null, diffHideWhitespace);
        }
        if (activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr') {
            const entry = comparisonDiffData.get(filePath);
            const entryData = !fullContext && entry ? comparisonResultDiffData(filePath, entry) : null;
            if (entryData) return resolveFindDiff(diffDataToFileDiff(filePath, entryData), diffHideWhitespace);
            const result = fullContext && loadFullComparisonDiff
                ? await loadFullComparisonDiff(filePath)
                : await fetchComparisonDiffEntry(filePath);
            const data = comparisonResultDiffData(filePath, result);
            if (!data) throw new Error(result.status === 'error' ? result.message : 'Diff not loaded');
            return resolveFindDiff(diffDataToFileDiff(filePath, data), diffHideWhitespace);
        }
        if (!effectiveDirectory || hasFileVersionsDiff(filePath)) return null;
        if (!git.getGitDiff) return null;
        const getGitDiff = git.getGitDiff;
        const staged = getFileStaged(findKey);
        const contextLines = fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
        const previousPath = file.previousPath;
        let response: Awaited<ReturnType<typeof getGitDiff>>;
        try {
            const batched = previousPath ? null : await readBatchedDiffForFind(effectiveDirectory, filePath, revision, staged, fullContext);
            if (batched && !batched.ok && batched.reason) throw new GitPathUnavailableError(batched.error, batched.reason);
            response = batched?.ok
                ? batched.diff
                : await getGitDiff(effectiveDirectory, { path: filePath, staged, contextLines, previousPath });
        } catch (error) {
            if (!(error instanceof GitPathUnavailableError)) throw error;
            if (error.reason === 'nested_repository') return readNestedRepositoryForFind(findKey, filePath, getLayoutForFile(file), revision);
            return null;
        }
        const next = { ...createTextDiffDataFromPatch(filePath, response.diff, fullContext ? 'full' : 'patch'), submodule: response.submodule };
        return resolveFindDiff(diffDataToFileDiff(filePath, next), diffHideWhitespace);
    }, [activeDiffScope, comparisonDiffData, diffHideWhitespace, effectiveDirectory, fetchComparisonDiffEntry, findFullContextFiles, findKeyOf, getFileStaged, getLayoutForFile, git, lastTurnDiffData, loadFullComparisonDiff, readBatchedDiffForFind, readNestedRepositoryForFind]);

    const loadFileDiffForFindRef = React.useRef(loadFileDiffForFind);
    loadFileDiffForFindRef.current = loadFileDiffForFind;

    const findRangeEntries = activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'
        ? comparisonDiffData
        : null;
    const findTurnEntries = activeDiffScope === 'turn' ? lastTurnDiffData : null;
    const findUsesLocalRead = activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged';
    const diffFindSources = React.useMemo<DiffFindSource[]>(
        () => changedFiles.map((file) => {
            const findKey = findKeyOf(file);
            const rangeEntry = findRangeEntries?.get(file.path);
            const content = findRangeEntries
                ? `${comparisonRangeKey ?? 'none'}:${comparisonPathRevisions?.get(file.path) ?? ''}:${rangeEntry?.status === 'error' ? 'error' : ''}`
                : findTurnEntries
                    ? findPayloadRevision(findTurnEntries.get(file.path))
                    : findUsesLocalRead
                        ? `${getFileStaged(findKey) ? 'staged' : 'unstaged'}:${workingTreeRevision + (fileDiffRefreshNonce.get(file.path) ?? 0)}:${file.index}${file.working_dir}:${file.insertions}:${file.deletions}`
                        : 'local';
            const revision = `${diffHideWhitespace ? 'hide' : 'show'}|${findFullContextFiles.has(findKey) ? 'full' : 'patch'}|${content}`;
            return {
                filePath: findKey,
                layout: getLayoutForFile(file),
                revision,
                load: () => loadFileDiffForFindRef.current(file, revision),
            };
        }),
        [changedFiles, comparisonPathRevisions, comparisonRangeKey, diffHideWhitespace, fileDiffRefreshNonce, findFullContextFiles, findKeyOf, findRangeEntries, findTurnEntries, findUsesLocalRead, getFileStaged, getLayoutForFile, workingTreeRevision],
    );

    diffFindSourcesRef.current = diffFindSources;
    const diffFind = useDiffFind({ sources: diffFindSources });

    const [findReveal, setFindReveal] = React.useState<DiffFindReveal | null>(null);
    const changedFilesRef = React.useRef(changedFiles);
    changedFilesRef.current = changedFiles;
    const revealLocation = React.useCallback((target: { filePath: string }) => {
        const rowFile = changedFilesRef.current.find((file) => isFindRevealFor(findKeyOf(file), target.filePath));
        const rowPath = rowFile ? findKeyOf(rowFile) : target.filePath;
        if (isTreeMode && rowPath !== displayFile) {
            setDisplayFile(rowPath);
            setDisplayFileStaged(activeDiffScope === 'staged');
        }
        cancelScrollHold();
        expandStackedFile(rowPath);
        scrollToFile(rowPath);
    }, [activeDiffScope, cancelScrollHold, displayFile, expandStackedFile, findKeyOf, isTreeMode, scrollToFile]);
    const revealFindMatch = React.useCallback((match: { filePath: string }) => {
        setFindReveal((previous) => ({ key: match.filePath, nonce: (previous?.nonce ?? 0) + 1 }));
        revealLocation(match);
    }, [revealLocation]);

    const { registerViewer: registerViewerRef, openOnWord: handleFindWordRequest, scrollToLocation, focusNonce: findFocusNonce } = useDiffFindSurface({
        find: diffFind,
        visible,
        rootRef: diffRootRef,
        reveal: revealFindMatch,
        revealLocation,
        scopeKey: JSON.stringify([activeDiffScope, comparisonKey, effectiveDirectory]),
    });

    return { handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest, scrollToLocation, findFocusNonce };
}
