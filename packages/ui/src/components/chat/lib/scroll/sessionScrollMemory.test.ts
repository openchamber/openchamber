import { describe, expect, test } from 'bun:test';
import { readSessionScrollPosition, rememberSessionScrollPosition } from './sessionScrollMemory';

describe('session scroll memory', () => {
    test('a session left at its end forgets the earlier position', () => {
        rememberSessionScrollPosition('end-case', { messageId: 'm1', offsetTop: -20 });
        expect(readSessionScrollPosition('end-case')).toEqual({ messageId: 'm1', offsetTop: -20 });

        rememberSessionScrollPosition('end-case', null);
        expect(readSessionScrollPosition('end-case')).toBeNull();
    });

    test('keeps the most recently left sessions within the limit', () => {
        rememberSessionScrollPosition('oldest', { messageId: 'a', offsetTop: 0 });
        for (let index = 0; index < 99; index += 1) {
            rememberSessionScrollPosition(`session-${index}`, { messageId: 'b', offsetTop: 0 });
        }
        // Leaving the oldest again makes it recent.
        rememberSessionScrollPosition('oldest', { messageId: 'a', offsetTop: 10 });
        rememberSessionScrollPosition('newest', { messageId: 'c', offsetTop: 0 });

        expect(readSessionScrollPosition('oldest')).toEqual({ messageId: 'a', offsetTop: 10 });
        expect(readSessionScrollPosition('session-0')).toBeNull();
        expect(readSessionScrollPosition('newest')).not.toBeNull();
    });
});
