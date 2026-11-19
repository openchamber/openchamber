import React from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { hasFileVersionsDiff } from '@/lib/toolHelpers';
import { type DiffViewMode } from '@/components/chat/message/types';
import { toastContextFileOpenFailure, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { getFirstChangedModifiedLineFromPatch } from '../diffPatchUtils';
import type { DiffData } from './types';
import { toAbsolutePath, getFirstChangedModifiedLine } from './diffData';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { useGitStore } from '@/stores/useGitStore';
import type { useUIStore } from '@/stores/useUIStore';

interface DiffViewEditorOptions {
    setDiffLayoutForAllFiles: ReturnType<typeof useUIStore.getState>['setDiffLayoutForAllFiles'];
    rootDirectory: string | undefined;
    effectiveDirectory: string | undefined;
    git: RuntimeAPIs['git'];
    activeDiffStaged: boolean;
    setDiff: ReturnType<typeof useGitStore.getState>['setDiff'];
    files: RuntimeAPIs['files'];
    openContextFileAtLine: ReturnType<typeof useUIStore.getState>['openContextFileAtLine'];
    setComparisonRetryRevision: React.Dispatch<React.SetStateAction<number>>;
}

export function useDiffViewEditor({
    setDiffLayoutForAllFiles, rootDirectory, effectiveDirectory, git, activeDiffStaged, setDiff, files,
    openContextFileAtLine, setComparisonRetryRevision,
}: DiffViewEditorOptions) {
    const handleHeaderLayoutChange = React.useCallback((mode: DiffViewMode) => {
        setDiffLayoutForAllFiles(mode === 'side-by-side' ? 'side-by-side' : 'inline');
    }, [setDiffLayoutForAllFiles]);

    const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

    const openFileInEditorAtChange = React.useCallback(async (filePath: string, cachedDiffData: DiffData | null) => {
        if (!rootDirectory || !effectiveDirectory || !filePath) {
            return;
        }

        setOpeningEditorFilePath(filePath);
        const runtimeKey = getRuntimeKey();
        try {
            let targetLine: number | null = null;

            if (cachedDiffData?.patch && !cachedDiffData.isBinary && !hasFileVersionsDiff(filePath)) {
                targetLine = getFirstChangedModifiedLineFromPatch(cachedDiffData.patch);
            } else if (cachedDiffData && cachedDiffData.contextMode === 'full' && !cachedDiffData.isBinary && !hasFileVersionsDiff(filePath)) {
                targetLine = getFirstChangedModifiedLine(cachedDiffData.original, cachedDiffData.modified);
            }

            if (targetLine === null && git.getGitDiff) {
                try {
                    const patchResponse = await git.getGitDiff(effectiveDirectory, {
                        path: filePath,
                        staged: activeDiffStaged,
                        contextLines: 3,
                    });
                    targetLine = getFirstChangedModifiedLineFromPatch(patchResponse.diff);
                } catch {
                    targetLine = null;
                }
            }

            let diffForNavigation = cachedDiffData;
            if ((targetLine === null || !diffForNavigation) && git.getGitFileDiff) {
                const response = await git.getGitFileDiff(effectiveDirectory, { path: filePath, staged: activeDiffStaged });
                const fetchedDiff = {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                    submodule: response.submodule,
                };
                diffForNavigation = fetchedDiff;
                if (!activeDiffStaged) {
                    setDiff(effectiveDirectory, filePath, fetchedDiff, runtimeKey);
                }
            }

            const resolvedTargetLine = targetLine
            ?? (diffForNavigation && !diffForNavigation.isBinary && !hasFileVersionsDiff(filePath)
              ? getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified)
              : 1);

            const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
            const openValidation = await validateContextFileOpen(files, absolutePath, { directory: effectiveDirectory });
            if (!openValidation.ok) {
                toastContextFileOpenFailure(absolutePath, openValidation);
                return;
            }

            openContextFileAtLine(
                rootDirectory,
                absolutePath,
                resolvedTargetLine,
                1,
            );
        } finally {
            setOpeningEditorFilePath((current) => (current === filePath ? null : current));
        }
    }, [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, rootDirectory, setDiff]);
    const handleOpenInEditor = React.useCallback((filePath: string, diffData: DiffData | null) => {
        void openFileInEditorAtChange(filePath, diffData);
    }, [openFileInEditorAtChange]);
    const handleRetryComparisonDiff = React.useCallback(() => setComparisonRetryRevision((revision) => revision + 1), []);

    return { handleHeaderLayoutChange, openingEditorFilePath, handleOpenInEditor, handleRetryComparisonDiff };
}
