import { afterEach, describe, expect, test } from 'bun:test';
import {
    finishReading,
    isCurrentReading,
    startReading,
    stopActiveReading,
    stopReadingUnderKey,
} from './activeReading';

const player = () => {
    const fake = { stops: 0, stop: () => { fake.stops += 1; } };
    return fake;
};

afterEach(() => {
    stopActiveReading();
});

describe('activeReading', () => {
    test('a new reading stops the one in progress', () => {
        const first = player();
        const second = player();
        const firstToken = startReading('message-a', first.stop);
        const secondToken = startReading('message-b', second.stop);

        expect(first.stops).toBe(1);
        expect(second.stops).toBe(0);
        expect(isCurrentReading(firstToken)).toBe(false);
        expect(isCurrentReading(secondToken)).toBe(true);
    });

    test('any control under the same key stops the reading, whoever started it', () => {
        const selectionMenuPlayer = player();
        const token = startReading('message-a', selectionMenuPlayer.stop);

        stopReadingUnderKey('message-b');
        expect(selectionMenuPlayer.stops).toBe(0);
        expect(isCurrentReading(token)).toBe(true);

        stopReadingUnderKey('message-a');
        expect(selectionMenuPlayer.stops).toBe(1);
        expect(isCurrentReading(token)).toBe(false);
    });

    test('the end of a replaced reading leaves the current one playing', () => {
        const first = startReading('message-a', player().stop);
        const second = startReading('message-a', player().stop);

        finishReading(first);
        expect(isCurrentReading(second)).toBe(true);

        finishReading(second);
        expect(isCurrentReading(second)).toBe(false);
    });

    test('finishing does not stop the player again', () => {
        const reading = player();
        const token = startReading('message-a', reading.stop);

        finishReading(token);
        stopActiveReading();
        expect(reading.stops).toBe(0);
    });
});
