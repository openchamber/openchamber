import { describe, expect, test } from 'bun:test';

import { partitionLiveTurn } from './useTurnRecords';

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
