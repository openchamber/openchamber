import React from 'react';
import { findRepoFile, isAbsoluteFilePath, toAbsoluteFilePath } from '@/lib/path-utils';
import { findFileRepository } from '@/lib/nestedRepositories';
import type { DiffScope, DiffViewProps } from './types';
import { useDiffViewSetup } from './useDiffViewSetup';
import { useDiffViewComparisons } from './useDiffViewComparisons';
import { useDiffViewStackedViewport } from './useDiffViewStackedViewport';


type useDiffViewNavigationProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'activeDiffScope' | 'pendingDiffScope' | 'pendingDiffFile' | 'setActiveDiffScope' | 'setDisplayFile' |
    'setDisplayFileStaged' | 'pendingDiffStaged' | 'setPendingDiffFile' | 'shouldPinAfterAlignRef' |
    'pendingScrollTargetRef' | 'expandStackedFile' | 'setScrollRequestNonce' | 'pendingTurnDiffFile' |
    'currentSessionId' | 'setPendingTurnDiffFile' | 'rootDirectory' | 'fallbackStatusRequestRef' | 'setChangedFallback' |
    'changedFallback' | 'effectiveDirectory' | 'repositoriesKnown' | 'rootIsGitRepo' | 'repositoryOptions' |
    'selectNestedRepo' | 'fetchStatus' | 'git' | 'displayFile' | 'fileSectionRefs' | 'cancelPendingScrollAlignment' |
    'setExpandedFiles' | 'setMountedStackedFiles'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'turnDiffSettled' | 'lastTurnDiffs' | 'changedFiles'
> & Pick<ReturnType<typeof useDiffViewStackedViewport>,
    'queueVisibleStackedFilesSyncRef' | 'queueVisibleStackedFilesSync'
> & {
    visible: boolean;
    targetFilePath: string | null;
    diffScope: DiffScope | null;
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
};

export function useDiffViewNavigation({
    visible, activeDiffScope, pendingDiffScope, pendingDiffFile, setActiveDiffScope, setDisplayFile,
    setDisplayFileStaged, pendingDiffStaged, setPendingDiffFile, shouldPinAfterAlignRef, pendingScrollTargetRef,
    expandStackedFile, setScrollRequestNonce, targetFilePath, pendingTurnDiffFile, diffScope, currentSessionId,
    setPendingTurnDiffFile, turnDiffSettled, rootDirectory, lastTurnDiffs, fallbackStatusRequestRef, setChangedFallback,
    onDiffScopeChange, changedFallback, effectiveDirectory, repositoriesKnown, rootIsGitRepo, repositoryOptions,
    selectNestedRepo, fetchStatus, git, changedFiles, displayFile, fileSectionRefs, queueVisibleStackedFilesSyncRef,
    cancelPendingScrollAlignment, setExpandedFiles, setMountedStackedFiles, queueVisibleStackedFilesSync,
}: useDiffViewNavigationProps) {
    // Handle pending diff file from external navigation
    React.useEffect(() => {
        if (!visible || (activeDiffScope !== 'all' && !pendingDiffScope)) {
            return;
        }

        if (pendingDiffFile) {
            if (pendingDiffScope) {
                setActiveDiffScope(pendingDiffScope);
            }
            setDisplayFile(pendingDiffFile);
            setDisplayFileStaged(pendingDiffScope === 'staged' || (!pendingDiffScope && pendingDiffStaged));
            setPendingDiffFile(null);
            shouldPinAfterAlignRef.current = true;
            pendingScrollTargetRef.current = pendingDiffFile;
            expandStackedFile(pendingDiffFile);
            setScrollRequestNonce((value) => value + 1);
        }
    }, [activeDiffScope, expandStackedFile, pendingDiffFile, pendingDiffScope, pendingDiffStaged, setPendingDiffFile, visible, setScrollRequestNonce, setDisplayFileStaged, setDisplayFile, shouldPinAfterAlignRef, setActiveDiffScope, pendingScrollTargetRef]);

    React.useEffect(() => {
        if (activeDiffScope === 'all') {
            return;
        }

        const normalizedTarget = targetFilePath?.trim();
        // Listings are relative, so a chip's absolute path names no row here.
        // Its click resolves the row through pendingTurnDiffFile below.
        if (!normalizedTarget || isAbsoluteFilePath(normalizedTarget)) {
            return;
        }

        setDisplayFile(normalizedTarget);
        setDisplayFileStaged(activeDiffScope === 'staged');

        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = normalizedTarget;
        expandStackedFile(normalizedTarget);
        setScrollRequestNonce((value) => value + 1);
    }, [activeDiffScope, expandStackedFile, targetFilePath, setScrollRequestNonce, setDisplayFileStaged, pendingScrollTargetRef, setDisplayFile, shouldPinAfterAlignRef]);

    const revealListedFile = React.useCallback((path: string) => {
        setDisplayFile(path);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = path;
        expandStackedFile(path);
        setScrollRequestNonce((value) => value + 1);
    }, [expandStackedFile, setScrollRequestNonce, setDisplayFileStaged, pendingScrollTargetRef, setDisplayFile, shouldPinAfterAlignRef]);

    // A click asked for a file in the last turn's diff. Only an answer to the
    // session's current state decides: a list kept from an earlier turn would
    // send a file this turn did change to Changed, and a failed read keeps its
    // retry. Asked once per click, so picking Last turn by hand stays there.
    React.useEffect(() => {
        if (!pendingTurnDiffFile || !visible) return;
        if (diffScope !== 'turn' || pendingTurnDiffFile.sessionId !== currentSessionId) {
            setPendingTurnDiffFile(null);
            return;
        }
        // Entering the scope resets what is expanded, so wait for that first.
        if (!turnDiffSettled || activeDiffScope !== 'turn') return;
        setPendingTurnDiffFile(null);
        const file = toAbsoluteFilePath(rootDirectory, pendingTurnDiffFile.file);
        const listed = findRepoFile(file, rootDirectory, lastTurnDiffs.flatMap((diff) => diff.file ?? []));
        if (listed) {
            revealListedFile(listed);
            return;
        }
        fallbackStatusRequestRef.current = null;
        setChangedFallback({ file, picked: false, statusReadFor: null });
        setActiveDiffScope('working');
        onDiffScopeChange?.('working');
    }, [activeDiffScope, currentSessionId, diffScope, lastTurnDiffs, onDiffScopeChange, pendingTurnDiffFile, revealListedFile, rootDirectory, setPendingTurnDiffFile, turnDiffSettled, visible, fallbackStatusRequestRef, setActiveDiffScope, setChangedFallback]);

    // Changed reads one repository, and the status on hand may predate the
    // turn, so the file is looked for in its own repository's fresh status. A
    // repository the picker drops again (a broken `.git`) ends the attempt.
    React.useEffect(() => {
        if (!changedFallback || !visible || !effectiveDirectory) return;
        if (activeDiffScope !== 'working') {
            setChangedFallback(null);
            return;
        }
        if (!repositoriesKnown) return;
        const repository = findFileRepository(changedFallback.file, [
            ...(rootIsGitRepo && rootDirectory ? [rootDirectory] : []),
            ...(repositoryOptions ?? []),
        ]);
        if (repository && repository !== effectiveDirectory && rootDirectory) {
            if (changedFallback.picked) {
                setChangedFallback(null);
                return;
            }
            setChangedFallback({ ...changedFallback, picked: true });
            selectNestedRepo(rootDirectory, repository);
            return;
        }
        if (changedFallback.statusReadFor !== effectiveDirectory) {
            if (fallbackStatusRequestRef.current === effectiveDirectory) return;
            fallbackStatusRequestRef.current = effectiveDirectory;
            void fetchStatus(effectiveDirectory, git, { silent: true }).finally(() => {
                setChangedFallback((current) => current && { ...current, statusReadFor: effectiveDirectory });
            });
            return;
        }
        setChangedFallback(null);
        const listed = findRepoFile(changedFallback.file, effectiveDirectory, changedFiles.map((file) => file.path));
        if (listed) revealListedFile(listed);
    }, [activeDiffScope, changedFallback, changedFiles, effectiveDirectory, fetchStatus, git, repositoriesKnown, repositoryOptions, revealListedFile, rootDirectory, rootIsGitRepo, selectNestedRepo, visible, fallbackStatusRequestRef, setChangedFallback]);

    React.useEffect(() => {
        if (!displayFile) {
            return;
        }

        const stillExists = changedFiles.some((file) => file.path === displayFile);
        if (!stillExists) {
            setDisplayFile(null);
            setDisplayFileStaged(false);
        }
    }, [changedFiles, displayFile, setDisplayFileStaged, setDisplayFile]);

    const registerSectionRef = React.useCallback((path: string, node: HTMLDivElement | null) => {
        const map = fileSectionRefs.current;
        if (node) {
            map.set(path, node);
        } else {
            map.delete(path);
        }
        queueVisibleStackedFilesSyncRef.current();
    }, [fileSectionRefs, queueVisibleStackedFilesSyncRef]);

    const handleStackedEntryExpandedChange = React.useCallback((path: string, expanded: boolean) => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            const hasPath = previous.has(path);
            if (expanded === hasPath) {
                return previous;
            }
            const next = new Set(previous);
            if (expanded) {
                next.add(path);
            } else {
                next.delete(path);
            }
            return next;
        });
        if (!expanded) {
            setMountedStackedFiles((previous) => {
                if (!previous.has(path)) return previous;
                const next = new Set(previous);
                next.delete(path);
                return next;
            });
        }
        queueVisibleStackedFilesSyncRef.current();
    }, [cancelPendingScrollAlignment, queueVisibleStackedFilesSyncRef, setExpandedFiles, setMountedStackedFiles]);

    const handleExpandOrCollapseAll = React.useCallback(() => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            if (previous.size > 0) {
                return new Set();
            }
            return new Set(changedFiles.map((file) => file.path));
        });
        setMountedStackedFiles(new Set());
        queueVisibleStackedFilesSync();
    }, [cancelPendingScrollAlignment, changedFiles, queueVisibleStackedFilesSync, setExpandedFiles, setMountedStackedFiles]);

    return { registerSectionRef, handleStackedEntryExpandedChange, handleExpandOrCollapseAll };
}
