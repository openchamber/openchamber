import { describe, expect, test } from 'bun:test';

import {
    estimateHistoryEntrySize,
    resolveHistoryWindowing,
} from './historyWindowing';

describe('resolveHistoryWindowing', () => {
    test('virtualizes a few turns when one contains many messages', () => {
        expect(resolveHistoryWindowing({
            entryCount: 4,
            maxEntryMessageCount: 52,
            isMobile: false,
        })).toEqual({
            shouldVirtualize: true,
            overscan: 0,
        });
    });

    test('preserves the existing small desktop and mobile behavior', () => {
        expect(resolveHistoryWindowing({
            entryCount: 4,
            maxEntryMessageCount: 2,
            isMobile: false,
        })).toEqual({
            shouldVirtualize: false,
            overscan: 8,
        });
        expect(resolveHistoryWindowing({
            entryCount: 4,
            maxEntryMessageCount: 2,
            isMobile: true,
        })).toEqual({
            shouldVirtualize: true,
            overscan: 16,
        });
    });
});

describe('estimateHistoryEntrySize', () => {
    test('accounts for all messages nested inside a turn', () => {
        expect(estimateHistoryEntrySize(52)).toBe(16_640);
        expect(estimateHistoryEntrySize(0)).toBe(320);
    });
});
