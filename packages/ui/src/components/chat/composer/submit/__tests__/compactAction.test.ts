import { describe, expect, test } from 'bun:test';

import { executeCompactAction } from '../compactAction';

const actionArgs = {
    sessionId: 'session-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    currentDirectory: '/workspace/fallback',
    getSessionDirectory: () => '/workspace/session',
};

type SummaryArgs = [string, string, string, (string | null | undefined)?];

describe('executeCompactAction', () => {
    test('button-triggered compaction preserves the typed cleanup path and summarizes the session', async () => {
        let typedCleanupCalls = 0;
        let connectionWaits = 0;
        const summaries: SummaryArgs[] = [];

        await executeCompactAction({
            ...actionArgs,
            buttonTriggered: true,
            consumeTypedCommand: () => { typedCleanupCalls += 1; },
            waitForConnectionOrThrow: async () => { connectionWaits += 1; },
            summarizeSession: async (...args) => {
                summaries.push(args);
                return true;
            },
        });

        expect(typedCleanupCalls).toBe(0);
        expect(connectionWaits).toBe(1);
        expect(summaries).toEqual([[
            'session-1',
            'provider-1',
            'model-1',
            '/workspace/session',
        ]]);
    });

    test('typed /compact still performs its draft cleanup before summarizing', async () => {
        let typedCleanupCalls = 0;
        let summarized = false;

        await executeCompactAction({
            ...actionArgs,
            buttonTriggered: false,
            consumeTypedCommand: () => { typedCleanupCalls += 1; },
            waitForConnectionOrThrow: async () => {},
            summarizeSession: async () => {
                summarized = true;
                return true;
            },
        });

        expect(typedCleanupCalls).toBe(1);
        expect(summarized).toBe(true);
    });
});
