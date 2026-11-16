import React from 'react';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useSpaceDirectoryStopped } from '@/lib/spaces/spaces-store';
import type { useSync } from '@/sync/use-sync';

/** Loading the shown session's messages: the first load, its retries and what the placeholder needs. */
export const useColumnSessionLoad = ({
    active,
    currentSessionId,
    effectiveSessionDirectory,
    sync,
    ensureSessionRenderable,
    hasRenderableSessionSnapshot,
    loadStatus,
}: {
    active: boolean;
    currentSessionId: string | null;
    effectiveSessionDirectory: string | undefined;
    sync: ReturnType<typeof useSync>;
    ensureSessionRenderable: (sessionId: string) => Promise<void>;
    hasRenderableSessionSnapshot: boolean;
    loadStatus: string;
}) => {
    const authSessionExpired = useAuthSessionStore((store) => store.state !== 'ok');
    const wasAuthExpiredRef = React.useRef(false);
    // The messages of a space's session live inside the space: while it is stopped, gone or out
    // of reach a load only waits for its timeout, so the chat holds it and says why instead.
    const spaceStopped = useSpaceDirectoryStopped(effectiveSessionDirectory);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const retrySessionLoad = React.useCallback(() => {
        if (!active || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId, true, effectiveSessionDirectory);
    }, [currentSessionId, effectiveSessionDirectory, active, sync]);

    // A load that failed while the session was expired retries itself the
    // moment the re-login lands — the error screen should never outlive its
    // cause.
    React.useEffect(() => {
        if (authSessionExpired) {
            wasAuthExpiredRef.current = true;
            return;
        }
        if (wasAuthExpiredRef.current) {
            wasAuthExpiredRef.current = false;
            if (loadStatus === 'error') {
                retrySessionLoad();
            }
        }
    }, [authSessionExpired, retrySessionLoad, loadStatus]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (hasRenderableSessionSnapshot || spaceStopped) return;
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot, active, spaceStopped]);

    // A space that runs again answers the load the chat held, or the one that failed while it
    // was going down: the user waiting on its start sees the chat without a retry.
    const wasSpaceStoppedRef = React.useRef(spaceStopped);
    React.useEffect(() => {
        const wasStopped = wasSpaceStoppedRef.current;
        wasSpaceStoppedRef.current = spaceStopped;
        if (wasStopped && !spaceStopped && !hasRenderableSessionSnapshot) retrySessionLoad();
    }, [hasRenderableSessionSnapshot, retrySessionLoad, spaceStopped]);

    return { authSessionExpired, spaceStopped, isSessionHydrating, retrySessionLoad };
};
