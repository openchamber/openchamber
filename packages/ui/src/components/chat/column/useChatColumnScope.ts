import React from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
    useChildStoreManager,
    useSessionMessageLoader,
    useSyncDirectory,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { createTimelineRevealGate, type TimelineRevealGate } from '../timelineRevealGate';
import type { ChatColumnSession } from '../chatColumnSession';

/**
 * What the shown session binds the column to: its directory, the key that
 * identifies its timeline, the history it protects while rendered, and the
 * reveal gate of the opened session.
 */
export const useChatColumnScope = ({
    pinned,
    currentSessionId,
    currentSessionDirectory,
}: {
    pinned: boolean;
    currentSessionId: string | null;
    currentSessionDirectory: string | null;
}) => {
    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const messageLoader = useSessionMessageLoader();
    // The app bootstraps only the current directory and the selected
    // session's. A pinned column may show a session of another project, so it
    // asks for its own directory while it is open.
    const childStores = useChildStoreManager();
    const columnDemandOwner = `chat-column:${React.useId()}`;
    React.useEffect(() => {
        if (!pinned || !effectiveSessionDirectory) return;
        childStores.setBootstrapDemand(columnDemandOwner, [{
            directory: effectiveSessionDirectory,
            priority: 'selected',
            reason: 'selected-session',
        }]);
        return () => childStores.clearBootstrapDemand(columnDemandOwner);
    }, [childStores, columnDemandOwner, effectiveSessionDirectory, pinned]);
    const currentSessionKey = currentSessionId
        ? JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId])
        : null;
    // A deferred switch can keep the previous transcript on screen after the
    // selected session changes. Protect what is actually rendered until commit.
    React.useLayoutEffect(() => {
        if (!currentSessionKey || !currentSessionId || !effectiveSessionDirectory) return;
        return messageLoader.retainSessionHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId }, 'rendered');
    }, [currentSessionKey, currentSessionId, effectiveSessionDirectory, messageLoader]);
    // One gate per opened session; the scroll hook holds it until the
    // viewport is pinned to the end so the first visible frame is already
    // at the bottom.
    const revealGateRef = React.useRef<{ key: string | null; gate: TimelineRevealGate } | null>(null);
    if (revealGateRef.current?.key !== currentSessionKey) {
        revealGateRef.current = { key: currentSessionKey, gate: createTimelineRevealGate() };
    }
    const revealGate = revealGateRef.current.gate;
    const chatColumnSession = React.useMemo<ChatColumnSession>(
        () => ({ sessionId: currentSessionId ?? null, directory: currentSessionId ? effectiveSessionDirectory ?? null : null }),
        [currentSessionId, effectiveSessionDirectory],
    );
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, false, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );
    const loadMoreMessages = React.useCallback(
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );

    return {
        sync,
        effectiveSessionDirectory,
        messageLoader,
        currentSessionKey,
        revealGate,
        chatColumnSession,
        ensureSessionRenderable,
        loadMoreMessages,
    };
};
