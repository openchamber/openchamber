import React from 'react';
import { useGitStore } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSessionStore } from '@/stores/useSessionStore';

/**
 * Background git polling hook - monitors git status regardless of which tab is open.
 * Must be used inside RuntimeAPIProvider.
 */
export function useGitPolling() {
    const { git } = useRuntimeAPIs();
    const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
    const { currentSessionId, sessions, worktreeMetadata: worktreeMap, sessionStatus } = useSessionStore();
    const { setActiveDirectory, startPolling, stopPolling, fetchAll } = useGitStore();

    const effectiveDirectory = React.useMemo(() => {
        const worktreeMetadata = currentSessionId
            ? worktreeMap.get(currentSessionId) ?? undefined
            : undefined;

        const currentSession = sessions.find((session) => session.id === currentSessionId);
        const sessionDirectory = (currentSession as { directory?: string | null } | undefined)?.directory ?? null;

        return worktreeMetadata?.path ?? sessionDirectory ?? fallbackDirectory ?? null;
    }, [currentSessionId, sessions, worktreeMap, fallbackDirectory]);

    const shouldPauseBackgroundPolling = React.useMemo(() => {
        if (!currentSessionId) {
            return false;
        }
        const activeStatus = sessionStatus?.get(currentSessionId)?.type;
        return activeStatus === 'busy' || activeStatus === 'retry';
    }, [currentSessionId, sessionStatus]);

    React.useEffect(() => {
        if (!effectiveDirectory || !git || shouldPauseBackgroundPolling) {
            stopPolling();
            return;
        }

        setActiveDirectory(effectiveDirectory);

        void fetchAll(effectiveDirectory, git, { silentIfCached: true });

        startPolling(git);

        return () => {
            stopPolling();
        };
    }, [effectiveDirectory, git, setActiveDirectory, shouldPauseBackgroundPolling, startPolling, stopPolling, fetchAll]);
}
