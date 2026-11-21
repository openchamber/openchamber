import React from 'react';
import { findRepoFile, toAbsoluteFilePath } from '@/lib/path-utils';
import { findFileRepository } from '@/lib/nestedRepositories';
import type { FilesAPI, GitAPI } from '@/lib/api/types';
import type { useUIStore } from '@/stores/useUIStore';
import type { NestedRepoDiscovery, useGitStore } from '@/stores/useGitStore';
import {
    beginChangedFileOpen, createLatestRequestGate, isProjectFileOutsideRepositories, openChangedFileWithoutRepository,
} from '../files/openChangedFileWithoutRepository';
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
    panelSessionId: string | null;
    turnDiffSettled: boolean;
    rootDirectory: string | undefined;
    lastTurnDiffs: TurnSnapshotDiff[];
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
    effectiveDirectory: string | undefined;
    repositoriesKnown: boolean;
    rootIsGitRepo: boolean | null;
    nestedRepos: NestedRepoDiscovery | undefined;
    repositoryOptions: string[] | null;
    selectNestedRepo: ReturnType<typeof useGitStore.getState>['selectNestedRepo'];
    fetchStatus: ReturnType<typeof useGitStore.getState>['fetchStatus'];
    git: GitAPI;
    changedFiles: FileEntry[];
    files: FilesAPI;
}

export function useDiffViewTurnNavigation({
    visible, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged, shouldPinAfterAlignRef,
    pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce, pendingTurnDiffFile, diffScope,
    panelSessionId, setPendingTurnDiffFile, turnDiffSettled, rootDirectory, lastTurnDiffs, onDiffScopeChange, effectiveDirectory,
    repositoriesKnown, rootIsGitRepo, nestedRepos, repositoryOptions, selectNestedRepo, fetchStatus, git, changedFiles,
    files,
}: DiffViewTurnNavigationOptions) {
    const [changedFallback, setChangedFallback] = React.useState<{
        file: string; picked: boolean; statusReadFor: string | null; isCurrent: () => boolean;
    } | null>(null);
    const fallbackStatusRequestRef = React.useRef<string | null>(null);
    const [editorOpenGate] = React.useState(createLatestRequestGate);
    const gateSessionRef = React.useRef(panelSessionId);
    const revealListedFile = React.useCallback((path: string) => {
        setDisplayFile(path);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = path;
        expandStackedFile(path);
        setScrollRequestNonce((value) => value + 1);
    }, [expandStackedFile]);

    React.useEffect(() => {
        if (!pendingTurnDiffFile) return;
        editorOpenGate.cancel();
        if (!visible) return;
        if (diffScope !== 'turn' || pendingTurnDiffFile.panelSessionId !== panelSessionId) {
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
        setChangedFallback({
            file, picked: false, statusReadFor: null, isCurrent: beginChangedFileOpen(editorOpenGate, panelSessionId),
        });
        setActiveDiffScope('working');
        onDiffScopeChange?.('working');
    }, [activeDiffScope, diffScope, editorOpenGate, lastTurnDiffs, onDiffScopeChange, panelSessionId, pendingTurnDiffFile, revealListedFile, rootDirectory, setPendingTurnDiffFile, turnDiffSettled, visible]);

    React.useEffect(() => {
        if (gateSessionRef.current !== panelSessionId) {
            gateSessionRef.current = panelSessionId;
            editorOpenGate.cancel();
        }
        if (!changedFallback || !visible || !effectiveDirectory) return;
        if (activeDiffScope !== 'working' || !changedFallback.isCurrent()) {
            setChangedFallback(null);
            return;
        }
        if (!repositoriesKnown) return;
        if (rootDirectory && isProjectFileOutsideRepositories(changedFallback.file, {
            rootDirectory, rootIsGitRepo, nestedRepos, repositories: repositoryOptions ?? [],
        })) {
            setChangedFallback(null);
            void openChangedFileWithoutRepository(changedFallback.file, rootDirectory, files, changedFallback.isCurrent);
            return;
        }
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
    }, [activeDiffScope, changedFallback, changedFiles, editorOpenGate, effectiveDirectory, fetchStatus, files, git, nestedRepos, repositoriesKnown, repositoryOptions, revealListedFile, rootDirectory, rootIsGitRepo, panelSessionId, selectNestedRepo, visible]);
}
