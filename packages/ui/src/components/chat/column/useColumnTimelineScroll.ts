import React from 'react';
import { toast } from '@/components/ui';
import { isOpencodeNotFound, opencodeClient } from '@/lib/opencode/client';
import { useChatTimelineScroll, type LinkedMessageState } from '@/hooks/useChatTimelineScroll';
import { useI18n } from '@/lib/i18n';
import type { MessageListHandle } from '../MessageList';
import type { TimelineRevealGate } from '../timelineRevealGate';

const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';

export const useColumnTimelineScroll = ({
    pinned,
    currentSessionId,
    currentSessionKey,
    effectiveSessionDirectory,
    composerOverlayHeight,
    messageListRef,
    sessionIsWorking,
    revealGate,
}: {
    pinned: boolean;
    currentSessionId: string | null;
    currentSessionKey: string | null;
    effectiveSessionDirectory: string | undefined;
    composerOverlayHeight: number;
    messageListRef: React.RefObject<MessageListHandle | null>;
    sessionIsWorking: boolean;
    revealGate: TimelineRevealGate;
}) => {
    const { t } = useI18n();
    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);
    const loadHistoryUntilMessageRef = React.useRef<(messageId: string, maxBatches: number) => Promise<boolean>>(async () => false);
    const currentSessionKeyRef = React.useRef(currentSessionKey);
    currentSessionKeyRef.current = currentSessionKey;
    const loadHistoryUntilMessage = React.useCallback(
        (messageId: string, maxBatches: number) => loadHistoryUntilMessageRef.current(messageId, maxBatches),
        [],
    );
    const handleLinkedMessageMissing = React.useCallback(() => {
        toast.info(t('chat.messageLink.notFound'));
    }, [t]);
    const checkLinkedMessage = React.useCallback(async (messageId: string): Promise<LinkedMessageState> => {
        if (!currentSessionId) return 'unknown';
        try {
            await opencodeClient.getSessionMessage(currentSessionId, messageId, effectiveSessionDirectory);
            return 'exists';
        } catch (error) {
            return isOpencodeNotFound(error) ? 'missing' : 'unknown';
        }
    }, [currentSessionId, effectiveSessionDirectory]);
    const scroll = useChatTimelineScroll({
        currentSessionId,
        currentSessionKey,
        composerOverlayHeight,
        messageListRef,
        loadHistoryUntilMessage,
        checkLinkedMessage,
        onLinkedMessageMissing: handleLinkedMessageMissing,
        sessionIsWorking,
        pinned,
        revealGate,
        onActiveTurnChange: handleActiveTurnChange,
    });
    const { goToBottom } = scroll;

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

    return {
        ...scroll,
        activeTurnChangeRef,
        loadHistoryUntilMessageRef,
        currentSessionKeyRef,
        checkLinkedMessage,
        handleLinkedMessageMissing,
    };
};
