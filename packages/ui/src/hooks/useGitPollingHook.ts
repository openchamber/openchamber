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
    const FORCE_DIFF_REFRESH_TOOLS = React.useMemo(() => new Set([
        'edit',
        'multiedit',
        'apply_patch',
        'write',
        'file_write',
        'create',
    ]), []);

    const { git } = useRuntimeAPIs();
    const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
    const { currentSessionId, sessions, worktreeMetadata: worktreeMap, sessionStatus } = useSessionStore();
    const { setActiveDirectory, startPolling, setPollingMode, stopPolling, fetchAll, fetchStatus, clearDiffCache } = useGitStore();
    const immediateRefreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastImmediateRefreshAtRef = React.useRef<number>(0);

    const effectiveDirectory = React.useMemo(() => {
        const worktreeMetadata = currentSessionId
            ? worktreeMap.get(currentSessionId) ?? undefined
            : undefined;

        const currentSession = sessions.find((session) => session.id === currentSessionId);
        const sessionDirectory = (currentSession as { directory?: string | null } | undefined)?.directory ?? null;

        return worktreeMetadata?.path ?? sessionDirectory ?? fallbackDirectory ?? null;
    }, [currentSessionId, sessions, worktreeMap, fallbackDirectory]);

    const activeSessionStatus = React.useMemo<'idle' | 'busy' | 'retry'>(() => {
        if (!currentSessionId) {
            return 'idle';
        }
        const activeStatus = sessionStatus?.get(currentSessionId)?.type;
        if (activeStatus === 'busy' || activeStatus === 'retry') {
            return activeStatus;
        }
        return 'idle';
    }, [currentSessionId, sessionStatus]);

    const pollingMode = activeSessionStatus === 'busy' || activeSessionStatus === 'retry' ? 'busy' : 'normal';

    React.useEffect(() => {
        setPollingMode(pollingMode);
    }, [pollingMode, setPollingMode]);

    const queueImmediateStatusRefresh = React.useCallback((
        delayMs: number = 300,
        options?: { directory?: string | null; forceDiffRefresh?: boolean }
    ) => {
        if (!git) {
            return;
        }

        const hintedDirectory = typeof options?.directory === 'string' && options.directory.trim().length > 0 && options.directory !== 'global'
            ? options.directory.trim()
            : null;
        const targetDirectory = hintedDirectory ?? effectiveDirectory;
        if (!targetDirectory) {
            return;
        }

        const shouldForceDiffRefresh = options?.forceDiffRefresh === true;

        const now = Date.now();
        if (now - lastImmediateRefreshAtRef.current < 800) {
            return;
        }

        if (immediateRefreshTimerRef.current) {
            clearTimeout(immediateRefreshTimerRef.current);
        }

        immediateRefreshTimerRef.current = setTimeout(() => {
            immediateRefreshTimerRef.current = null;
            lastImmediateRefreshAtRef.current = Date.now();
            void (async () => {
                const statusChanged = await fetchStatus(targetDirectory, git, { silent: true });
                if (shouldForceDiffRefresh && !statusChanged) {
                    clearDiffCache(targetDirectory);
                }
            })();
        }, delayMs);
    }, [clearDiffCache, effectiveDirectory, fetchStatus, git]);

    React.useEffect(() => {
        if (!effectiveDirectory || !git) {
            stopPolling();
            return;
        }

        setActiveDirectory(effectiveDirectory);

        void fetchAll(effectiveDirectory, git, { silentIfCached: true });
        startPolling(git);

        return () => {
            stopPolling();
        };
    }, [activeSessionStatus, effectiveDirectory, fetchAll, git, setActiveDirectory, startPolling, stopPolling]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handleGitRefreshHint = (event: Event) => {
            const customEvent = event as CustomEvent<{ directory?: string | null; toolName?: string | null }>;
            const toolName = typeof customEvent.detail?.toolName === 'string'
                ? customEvent.detail.toolName.toLowerCase()
                : null;
            queueImmediateStatusRefresh(200, {
                directory: customEvent.detail?.directory ?? null,
                forceDiffRefresh: Boolean(toolName && FORCE_DIFF_REFRESH_TOOLS.has(toolName)),
            });
        };

        window.addEventListener('openchamber:git-refresh-hint', handleGitRefreshHint as EventListener);
        return () => {
            window.removeEventListener('openchamber:git-refresh-hint', handleGitRefreshHint as EventListener);
        };
    }, [FORCE_DIFF_REFRESH_TOOLS, queueImmediateStatusRefresh]);

    React.useEffect(() => {
        return () => {
            if (immediateRefreshTimerRef.current) {
                clearTimeout(immediateRefreshTimerRef.current);
                immediateRefreshTimerRef.current = null;
            }
        };
    }, []);
}
