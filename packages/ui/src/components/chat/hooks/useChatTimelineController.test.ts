import { describe, expect, test } from 'bun:test';

import {
    isOlderHistoryPrependCommit,
} from './useChatTimelineController';

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
