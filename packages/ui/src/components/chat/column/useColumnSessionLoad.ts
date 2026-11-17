import React from 'react';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useSpaceDirectoryStopped } from '@/lib/spaces/spaces-store';
import type { useSync } from '@/sync/use-sync';

export const useColumnSessionLoad = ({
    active,
    currentSessionId,
    effectiveSessionDirectory,
    sync,
    ensureSessionRenderable,
    currentSessionKey,
    onManualNavigation,
    restoreSnapshot,
    hasRenderableSessionSnapshot,
    loadStatus,
}: {
    active: boolean;
    currentSessionId: string | null;
    effectiveSessionDirectory: string | undefined;
    sync: ReturnType<typeof useSync>;
    ensureSessionRenderable: (sessionId: string) => Promise<void>;
    currentSessionKey: string | null;
    onManualNavigation: () => void;
    restoreSnapshot: () => Promise<boolean>;
    hasRenderableSessionSnapshot: boolean;
    loadStatus: string;
}) => {
    const authSessionExpired = useAuthSessionStore((store) => store.state !== 'ok');
    const wasAuthExpiredRef = React.useRef(false);
    const spaceStopped = useSpaceDirectoryStopped(effectiveSessionDirectory);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const retrySessionLoad = React.useCallback(() => {
        if (!active || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId, true, effectiveSessionDirectory);
    }, [currentSessionId, effectiveSessionDirectory, active, sync]);

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

    const lastScrolledSessionKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (lastScrolledSessionKeyRef.current === currentSessionKey) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionKeyRef.current = currentSessionKey;
        if (hasHashTarget) {
            onManualNavigation();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [active, currentSessionId, currentSessionKey, onManualNavigation, restoreSnapshot]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (hasRenderableSessionSnapshot || spaceStopped) return;
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot, active, spaceStopped]);

    const wasSpaceStoppedRef = React.useRef(spaceStopped);
    React.useEffect(() => {
        const wasStopped = wasSpaceStoppedRef.current;
        wasSpaceStoppedRef.current = spaceStopped;
        if (wasStopped && !spaceStopped && !hasRenderableSessionSnapshot) retrySessionLoad();
    }, [hasRenderableSessionSnapshot, retrySessionLoad, spaceStopped]);

    return { authSessionExpired, spaceStopped, isSessionHydrating, retrySessionLoad };
};
