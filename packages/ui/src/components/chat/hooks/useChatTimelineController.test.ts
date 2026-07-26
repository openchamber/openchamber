import { describe, expect, test } from 'bun:test';

import {
    isOlderHistoryPrependCommit,
    shouldAutoLoadEarlierForUnderfilledPinnedViewport,
} from './useChatTimelineController';

const baseInput = {
    sessionId: 'ses_1',
    isPinned: true,
    canLoadEarlier: true,
    isLoadingOlder: false,
    pendingRevealWork: false,
    scrollHeight: 799,
    clientHeight: 800,
};

describe('shouldAutoLoadEarlierForUnderfilledPinnedViewport', () => {
    test('loads when pinned content does not fill the viewport', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport(baseInput)).toBe(true);
    });

    test('does not load when content already overflows', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 802,
        })).toBe(false);
    });

    test('does not load while user is away from bottom or history work is active', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isPinned: false,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isLoadingOlder: true,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            pendingRevealWork: true,
        })).toBe(false);
    });
});

describe('isOlderHistoryPrependCommit', () => {
    test('detects older messages inserted above the existing timeline', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_4',
        })).toBe(true);
    });

    test('does not treat appends or replacements as prepends', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_2',
            currentNewestId: 'msg_5',
        })).toBe(false);
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_5',
        })).toBe(false);
    });
});
