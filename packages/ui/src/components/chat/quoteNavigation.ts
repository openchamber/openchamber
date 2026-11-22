import type { MessageListHandle } from './MessageList';
import type { LinkedMessageState } from '@/hooks/useChatTimelineScroll';

type SessionKeyRef = { current: string | null };
type LoadHistoryUntilMessage = (messageId: string, options: { maxBatches: number }) => Promise<boolean>;
type ScrollToMessage = (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;

export async function loadQuoteSource(
    messageId: string,
    options: {
        currentSessionKey: string | null;
        currentSessionKeyRef: SessionKeyRef;
        onManualNavigation: () => void;
        loadHistoryUntilMessage: LoadHistoryUntilMessage;
        checkLinkedMessage: (messageId: string) => Promise<LinkedMessageState>;
        onLinkedMessageMissing: () => void;
    },
): Promise<boolean> {
    const sessionKey = options.currentSessionKey;
    options.onManualNavigation();

    const alreadyLoaded = await options.loadHistoryUntilMessage(messageId, { maxBatches: 0 });
    if (options.currentSessionKeyRef.current !== sessionKey) return false;
    if (alreadyLoaded) return true;

    const state = await options.checkLinkedMessage(messageId);
    if (options.currentSessionKeyRef.current !== sessionKey) return false;
    if (state === 'missing') {
        options.onLinkedMessageMissing();
        return false;
    }

    return options.loadHistoryUntilMessage(messageId, { maxBatches: Number.POSITIVE_INFINITY });
}

export async function scrollToQuoteSource(
    messageId: string,
    options: {
        currentSessionKey: string | null;
        currentSessionKeyRef: SessionKeyRef;
        scrollToTimelineMessage: ScrollToMessage;
        messageListRef: { current: MessageListHandle | null };
        behavior?: ScrollBehavior;
    },
): Promise<boolean> {
    if (options.currentSessionKeyRef.current !== options.currentSessionKey) return false;
    const scrollOptions = options.behavior ? { behavior: options.behavior } : undefined;
    const scrolled = await options.scrollToTimelineMessage(messageId, scrollOptions);
    if (options.currentSessionKeyRef.current !== options.currentSessionKey) return false;
    return scrolled || (options.messageListRef.current?.scrollToMessageId(messageId, scrollOptions) ?? false);
}
