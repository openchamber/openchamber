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

export const useChatColumnScope = ({
    pinned,
    currentSessionId,
    currentSessionDirectory,
}: {
    pinned: boolean;
    currentSessionId: string | null;
    currentSessionDirectory: string | null;
}) => {
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const messageLoader = useSessionMessageLoader();
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
    React.useLayoutEffect(() => {
        if (!currentSessionKey || !currentSessionId || !effectiveSessionDirectory) return;
        return messageLoader.retainSessionHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId }, 'rendered');
    }, [currentSessionKey, currentSessionId, effectiveSessionDirectory, messageLoader]);
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
