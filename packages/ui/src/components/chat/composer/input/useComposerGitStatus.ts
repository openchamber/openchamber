import React from 'react';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '../../composer/attachments/filePaths';


export function useComposerGitStatus(
    currentDirectory: string | undefined,
    runtimeGit: ReturnType<typeof useRuntimeAPIs>['git'],
) {
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);

    const fetchGitStatus = useGitStore((state) => state.fetchStatus);

    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);
}
