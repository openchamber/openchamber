import React from 'react';
import { type GitPathDiffBatchEntry } from '@/lib/api/types';
import { GitPathUnavailableError } from '@/lib/api/git-path-diff';
import { hasFileVersionsDiff } from '@/lib/toolHelpers';
import { type FileDiffMetadata } from '@pierre/diffs';
import { type DiffFindMatch } from '@/lib/diff/diffFind';
import { resolveFindDiff, useDiffFind, type DiffFindLayout, type DiffFindNestedSources, type DiffFindSource } from '../diffFind/useDiffFind';
import { useDiffFindSurface } from '../diffFind/useDiffFindSurface';
import { createFindDiffBatchReader } from '../diffFind/findDiffBatch';
import type { FileEntry, DiffFindReveal, DiffScope, DiffData, ComparisonDiffResult } from './types';
import {
    isStagedStatusFile, isWorkingStatusFile, toAbsolutePath, createTextDiffDataFromPatch, diffDataToFileDiff,
    findPayloadRevision, isFindRevealFor, toNestedFileEntries,
} from './diffData';
import { FULL_CONTEXT_DIFF_LINES, DEFAULT_CONTEXT_DIFF_LINES } from './diffContextLines';
import type { GitAPI } from '@/lib/api/types';

interface DiffViewFindOptions {
    effectiveDirectory: string | undefined;
    git: GitAPI;
    diffHideWhitespace: boolean;
    activeDiffScope: DiffScope;
    workingTreeRevision: number;
    fileDiffRefreshNonce: Map<string, number>;
    displayFile: string | null;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    expandStackedFile: (path: string) => void;
    diffRootRef: React.RefObject<HTMLDivElement | null>;
    lastTurnDiffData: Map<string, DiffData>;
    comparisonDiffData: ReadonlyMap<string, ComparisonDiffResult>;
    loadFullComparisonDiff: ((path: string) => Promise<ComparisonDiffResult>) | undefined;
    fetchComparisonDiffEntry: (path: string, fullContext?: boolean) => Promise<ComparisonDiffResult>;
    changedFiles: FileEntry[];
    getLayoutForFile: (file: FileEntry) => 'inline' | 'side-by-side';
    getFileStaged: (path: string) => boolean;
    scrollToFile: (path: string) => boolean;
    isTreeMode: boolean;
    visible: boolean;
}

export function useDiffViewFind({
    effectiveDirectory, git, diffHideWhitespace, getFileStaged, activeDiffScope, lastTurnDiffData, comparisonDiffData,
    loadFullComparisonDiff, fetchComparisonDiffEntry, getLayoutForFile, changedFiles, workingTreeRevision,
    fileDiffRefreshNonce, isTreeMode, displayFile, setDisplayFile, setDisplayFileStaged, expandStackedFile, scrollToFile,
    visible, diffRootRef,
}: DiffViewFindOptions) {
    // ----- Find in diff -----
    // Files the bar can search. `load` mirrors the viewer's own read: the side
    // it shows, the context it shows (a file whose collapsed context the user
    // expanded shows the whole file), and for a nested repository's row, the
    // files read from that repository. A range scope reads a file's patch
    // through the same fetchComparisonDiffEntry the expanded entries use (that
    // call does not write into the range cache, so an unexpanded file the bar
    // read is fetched again when it is later expanded).
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
        rowPath: string,
        layout: DiffFindLayout,
        revision: string,
    ): Promise<DiffFindNestedSources | null> => {
        if (!effectiveDirectory) return null;
        const nestedDirectory = toAbsolutePath(effectiveDirectory, rowPath);
        const status = await git.getGitStatus(nestedDirectory, { fresh: true });
        // Same reads as NestedRepositoryFileDiff: the side the row shows, at
        // patch context. Keys are the row path plus the nested path, the key
        // that row's viewers register under.
        return {
            nestedSources: toNestedFileEntries(status).map((nestedFile) => ({
                filePath: `${rowPath}${nestedFile.path}`,
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

    // The bar reads files one at a time; the first local read asks for every
    // file of its side and context in one request (`findDiffBatch.ts`), and a
    // runtime without the batched read (VS Code) reads each file on its own.
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
            .map((source) => ({ filePath: source.filePath, revision: source.revision ?? '' }));
        return readFindDiffBatch({
            directory,
            filePath,
            revision,
            staged,
            contextLines: fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES,
            peers,
            getGitDiffs: (target, options) => git.getGitDiffs?.(target, options) ?? Promise.resolve([]),
        });
    }, [findFullContextFiles, getFileStaged, git, readFindDiffBatch]);

    const loadFileDiffForFind = React.useCallback(async (
        file: FileEntry,
        revision: string,
    ): Promise<FileDiffMetadata | DiffFindNestedSources | null> => {
        const filePath = file.path;
        const fullContext = findFullContextFiles.has(filePath);
        if (activeDiffScope === 'turn') {
            const data = lastTurnDiffData.get(filePath);
            return resolveFindDiff(data ? diffDataToFileDiff(filePath, data) : null, diffHideWhitespace);
        }
        if (activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr') {
            const entry = comparisonDiffData.get(filePath);
            if (!fullContext && entry?.status === 'ready') {
                return resolveFindDiff(diffDataToFileDiff(filePath, entry.data), diffHideWhitespace);
            }
            // Reserved: the range cache owns this read; the revision moves when it lands.
            if (!fullContext && entry?.status === 'loading') return null;
            const result = fullContext && loadFullComparisonDiff
                ? await loadFullComparisonDiff(filePath)
                : await fetchComparisonDiffEntry(filePath);
            if (result.status !== 'ready') throw new Error(result.status === 'error' ? result.message : 'Diff not loaded');
            return resolveFindDiff(diffDataToFileDiff(filePath, result.data), diffHideWhitespace);
        }
        if (!effectiveDirectory || hasFileVersionsDiff(filePath)) return null;
        if (!git.getGitDiff) return null;
        const getGitDiff = git.getGitDiff;
        // Search exactly the side the viewer renders. `getGitDiff` reads the
        // unstaged (index -> working tree) side when `staged` is false and the
        // staged (HEAD -> index) side when it is true, the same read the viewer
        // does. `getGitFileDiff`'s unstaged read is the combined HEAD -> working
        // tree diff, a different side, so it must not be searched here. Nothing
        // is written to the shared diffCache, which holds `getGitFileDiff`
        // output for the viewer's fallback and the prefetcher.
        const staged = getFileStaged(filePath);
        const contextLines = fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
        // The batched read compares destination paths only; a rename is read
        // on its own against its source, as the viewer reads it.
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
            if (error.reason === 'nested_repository') return readNestedRepositoryForFind(filePath, getLayoutForFile(file), revision);
            // Gone since the listing, or a folder Git keeps as one row: the
            // entry shows a note and there is nothing to search.
            return null;
        }
        const next = { ...createTextDiffDataFromPatch(filePath, response.diff, fullContext ? 'full' : 'patch'), submodule: response.submodule };
        return resolveFindDiff(diffDataToFileDiff(filePath, next), diffHideWhitespace);
    }, [activeDiffScope, comparisonDiffData, diffHideWhitespace, effectiveDirectory, fetchComparisonDiffEntry, findFullContextFiles, getFileStaged, getLayoutForFile, git, lastTurnDiffData, loadFullComparisonDiff, readBatchedDiffForFind, readNestedRepositoryForFind]);

    // `diffFindSources` must stay identity-stable across renders, so `load`
    // reads the latest reader through this ref instead of capturing it.
    const loadFileDiffForFindRef = React.useRef(loadFileDiffForFind);
    loadFileDiffForFindRef.current = loadFileDiffForFind;

    // `revision` is what the hook re-reads on: hiding whitespace changes the
    // rendered diff, expanding a file's context shows the whole file, the side
    // (staged vs working) changes which content is searched, a live diff's
    // refresh signal moves with an edit, and a range or turn payload replaced
    // by a new read changes the content. Layout is deliberately excluded. The
    // range and turn maps are read through scope-gated handles so another
    // scope keeps `sources` identity-stable.
    const findRangeEntries = activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'
        ? comparisonDiffData
        : null;
    const findTurnEntries = activeDiffScope === 'turn' ? lastTurnDiffData : null;
    // The local read path (all/working/staged) resolves a per-file side; the
    // range and turn paths ignore it. Gating the side token on this keeps range
    // `sources` identity-stable when the selected file moves.
    const findUsesLocalRead = activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged';
    const diffFindSources = React.useMemo<DiffFindSource[]>(
        () => changedFiles.map((file) => {
            const rangeEntry = findRangeEntries?.get(file.path);
            const content = findRangeEntries
                ? `${rangeEntry?.status ?? 'absent'}:${findPayloadRevision(rangeEntry)}`
                : findTurnEntries
                    ? findPayloadRevision(findTurnEntries.get(file.path))
                    : findUsesLocalRead
                        ? `${getFileStaged(file.path) ? 'staged' : 'unstaged'}:${workingTreeRevision + (fileDiffRefreshNonce.get(file.path) ?? 0)}`
                        : 'local';
            const revision = `${diffHideWhitespace ? 'hide' : 'show'}|${findFullContextFiles.has(file.path) ? 'full' : 'patch'}|${content}`;
            return {
                filePath: file.path,
                layout: getLayoutForFile(file),
                revision,
                load: () => loadFileDiffForFindRef.current(file, revision),
            };
        }),
        [changedFiles, diffHideWhitespace, fileDiffRefreshNonce, findFullContextFiles, findRangeEntries, findTurnEntries, findUsesLocalRead, getFileStaged, getLayoutForFile, workingTreeRevision],
    );

    diffFindSourcesRef.current = diffFindSources;
    const diffFind = useDiffFind({ sources: diffFindSources });

    // Bumped with each jump so the entry holding the match renders it even when
    // it is behind "Render anyway", and a nested repository opens its file.
    const [findReveal, setFindReveal] = React.useState<DiffFindReveal | null>(null);
    const changedFilesRef = React.useRef(changedFiles);
    changedFilesRef.current = changedFiles;
    const revealFindMatch = React.useCallback((match: DiffFindMatch) => {
        // A nested repository's file is keyed under its row's `dir/` path.
        const rowPath = changedFilesRef.current.find((file) => isFindRevealFor(file.path, match.filePath))?.path ?? match.filePath;
        setFindReveal((previous) => ({ key: match.filePath, nonce: (previous?.nonce ?? 0) + 1 }));
        // Showing another file shows its default side, like every other way of
        // selecting it; the side its matches were read from depends on it.
        if (isTreeMode && rowPath !== displayFile) {
            setDisplayFile(rowPath);
            setDisplayFileStaged(activeDiffScope === 'staged');
        }
        expandStackedFile(rowPath);
        scrollToFile(rowPath);
    }, [activeDiffScope, displayFile, expandStackedFile, isTreeMode, scrollToFile]);

    const { registerViewer: registerViewerRef, openOnWord: handleFindWordRequest, focusNonce: findFocusNonce } = useDiffFindSurface({
        find: diffFind,
        visible,
        rootRef: diffRootRef,
        reveal: revealFindMatch,
    });

    return { handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest, findFocusNonce };
}
