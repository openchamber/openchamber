import { expect, test } from 'bun:test';

import type { MessageListHandle } from './MessageList';
import { loadQuoteSource, scrollToQuoteSource } from './quoteNavigation';

test('reports a confirmed missing quote source without paging through history', async () => {
    const historyRequests: number[] = [];
    let missingNoticeCount = 0;
    const loaded = await loadQuoteSource('missing-message', {
        currentSessionKey: 'session-a',
        currentSessionKeyRef: { current: 'session-a' },
        onManualNavigation: () => undefined,
        loadHistoryUntilMessage: async (_messageId, { maxBatches }) => {
            historyRequests.push(maxBatches);
            return false;
        },
        checkLinkedMessage: async () => 'missing',
        onLinkedMessageMissing: () => { missingNoticeCount += 1; },
    });

    expect(loaded).toBe(false);
    expect(historyRequests).toEqual([0]);
    expect(missingNoticeCount).toBe(1);
});

test('falls back to the rendered message list when the timeline index misses', async () => {
    const scrolls: string[] = [];
    const messageList: MessageListHandle = {
        scrollToTurnId: () => false,
        scrollToMessageId: (messageId) => {
            scrolls.push(messageId);
            return true;
        },
        captureViewportAnchor: () => null,
        restoreViewportAnchor: () => false,
        alignViewportAnchor: () => 'missing',
        holdViewportAnchor: () => undefined,
        isHistoryVirtualized: () => false,
        scrollToBottom: () => undefined,
    };

    const scrolled = await scrollToQuoteSource('parentless-reply', {
        currentSessionKey: 'session-a',
        currentSessionKeyRef: { current: 'session-a' },
        scrollToTimelineMessage: async () => false,
        messageListRef: { current: messageList },
    });

    expect(scrolled).toBe(true);
    expect(scrolls).toEqual(['parentless-reply']);
});
