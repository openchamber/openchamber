import { describe, expect, test } from 'bun:test';

import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry } from '../lib/turns/types';
import {
    collectTrailingUngroupedMessages,
    partitionLiveTurn,
    shouldKeepLastTurnLive,
} from './useTurnRecords';

const message = (id: string, role: 'user' | 'assistant', parentID?: string): ChatMessageEntry => ({
    info: { id, role, parentID } as ChatMessageEntry['info'],
    parts: [],
});

describe('shouldKeepLastTurnLive', () => {
    test('keeps an actively streaming turn live', () => {
        expect(shouldKeepLastTurnLive(true, 'assistant_1', { assistantMessages: [message('assistant_1', 'assistant')] })).toBe(true);
    });

    test('keeps the busy user-only turn live while waiting for an assistant', () => {
        expect(shouldKeepLastTurnLive(true, null, { assistantMessages: [] })).toBe(true);
    });

    test('virtualizes a completed tail while retrying without an active stream', () => {
        expect(shouldKeepLastTurnLive(true, null, { assistantMessages: [message('assistant_1', 'assistant')] })).toBe(false);
    });

    test('ignores a late assistant attached to an earlier turn', () => {
        const projection = projectTurnRecords([
            message('user_1', 'user'),
            message('user_2', 'user'),
            message('assistant_1', 'assistant', 'user_1'),
        ]);
        expect(shouldKeepLastTurnLive(true, null, projection.turns[1])).toBe(true);
    });

    test('ignores an orphan assistant after the final user message', () => {
        const projection = projectTurnRecords([
            message('user_1', 'user'),
            message('assistant_orphan', 'assistant'),
        ]);
        expect(shouldKeepLastTurnLive(true, null, projection.turns[0])).toBe(true);
    });
});

describe('partitionLiveTurn', () => {
    test('keeps every completed turn in virtualized history', () => {
        expect(partitionLiveTurn(['one', 'two', 'three'], false)).toEqual({
            staticTurns: ['one', 'two', 'three'],
            streamingTurn: undefined,
        });
    });

    test('keeps only the active tail outside history', () => {
        expect(partitionLiveTurn(['one', 'two', 'three'], true)).toEqual({
            staticTurns: ['one', 'two'],
            streamingTurn: 'three',
        });
    });
});

describe('collectTrailingUngroupedMessages', () => {
    const messages = ['user', 'assistant', 'system_1', 'system_2'].map((id) => ({ info: { id } }));

    test('preserves the order of the ungrouped suffix after a live turn', () => {
        expect(collectTrailingUngroupedMessages(
            messages,
            new Set(['system_1', 'system_2']),
            true,
        ).map((message) => message.info.id)).toEqual(['system_1', 'system_2']);
    });

    test('leaves the suffix in static history when there is no live turn', () => {
        expect(collectTrailingUngroupedMessages(
            messages,
            new Set(['system_1', 'system_2']),
            false,
        )).toEqual([]);
    });
});
