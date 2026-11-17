import React from 'react';
import { findRepoFile, toAbsoluteFilePath } from '@/lib/path-utils';
import { findFileRepository } from '@/lib/nestedRepositories';
import type { GitAPI } from '@/lib/api/types';
import type { useUIStore } from '@/stores/useUIStore';
import type { useGitStore } from '@/stores/useGitStore';
import type { TurnSnapshotDiff } from '../turnSnapshotDiff';
import type { DiffScope, DiffViewProps, FileEntry } from './types';

interface DiffViewTurnNavigationOptions {
    visible: boolean;
    activeDiffScope: DiffScope;
    setActiveDiffScope: React.Dispatch<React.SetStateAction<DiffScope>>;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    expandStackedFile: (path: string) => void;
    setScrollRequestNonce: React.Dispatch<React.SetStateAction<number>>;
    pendingTurnDiffFile: ReturnType<typeof useUIStore.getState>['pendingTurnDiffFile'];
    setPendingTurnDiffFile: ReturnType<typeof useUIStore.getState>['setPendingTurnDiffFile'];
    diffScope: DiffScope | null;
    currentSessionId: string | null;
    turnDiffSettled: boolean;
    rootDirectory: string | undefined;
    lastTurnDiffs: TurnSnapshotDiff[];
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
    effectiveDirectory: string | undefined;
    repositoriesKnown: boolean;
    rootIsGitRepo: boolean | null;
    repositoryOptions: string[] | null;
    selectNestedRepo: ReturnType<typeof useGitStore.getState>['selectNestedRepo'];
    fetchStatus: ReturnType<typeof useGitStore.getState>['fetchStatus'];
    git: GitAPI;
    changedFiles: FileEntry[];
}

export function useDiffViewTurnNavigation({
    visible, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged, shouldPinAfterAlignRef,
    pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce, pendingTurnDiffFile, diffScope, currentSessionId,
    setPendingTurnDiffFile, turnDiffSettled, rootDirectory, lastTurnDiffs, onDiffScopeChange, effectiveDirectory,
    repositoriesKnown, rootIsGitRepo, repositoryOptions, selectNestedRepo, fetchStatus, git, changedFiles,
}: DiffViewTurnNavigationOptions) {
    const [changedFallback, setChangedFallback] = React.useState<{ file: string; picked: boolean; statusReadFor: string | null } | null>(null);
    const fallbackStatusRequestRef = React.useRef<string | null>(null);
    const revealListedFile = React.useCallback((path: string) => {
        setDisplayFile(path);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = path;
        expandStackedFile(path);
        setScrollRequestNonce((value) => value + 1);
    }, [expandStackedFile]);

    React.useEffect(() => {
        if (!pendingTurnDiffFile || !visible) return;
        if (diffScope !== 'turn' || pendingTurnDiffFile.sessionId !== currentSessionId) {
            setPendingTurnDiffFile(null);
            return;
        }
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
    }, [activeDiffScope, currentSessionId, diffScope, lastTurnDiffs, onDiffScopeChange, pendingTurnDiffFile, revealListedFile, rootDirectory, setPendingTurnDiffFile, turnDiffSettled, visible]);

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
    }, [activeDiffScope, changedFallback, changedFiles, effectiveDirectory, fetchStatus, git, repositoriesKnown, repositoryOptions, revealListedFile, rootDirectory, rootIsGitRepo, selectNestedRepo, visible]);
}
