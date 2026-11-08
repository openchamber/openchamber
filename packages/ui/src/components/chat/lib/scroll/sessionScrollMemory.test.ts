import { describe, expect, test } from 'bun:test';
import { readSessionScrollPosition, rememberOutgoingSessionScrollPosition, rememberSessionScrollPosition } from './sessionScrollMemory';

describe('session scroll memory', () => {
    test('a session left away from the end with an unmeasurable container keeps its record', () => {
        // The outgoing timeline is display:none while its KeepAlive entry
        // swaps, so the anchor capture finds no visible row and returns null
        // while the geometry is stale. That is not the user having left at
        // the end: the previous record must survive (#6045).
        rememberSessionScrollPosition('hidden-case', { messageId: 'm1', offsetTop: -120 });

        rememberOutgoingSessionScrollPosition('hidden-case', false, null);

        expect(readSessionScrollPosition('hidden-case')).toEqual({ messageId: 'm1', offsetTop: -120 });
    });

    test('a session left away from the end with a measured anchor saves it', () => {
        rememberSessionScrollPosition('measured-case', { messageId: 'm1', offsetTop: -40 });

        rememberOutgoingSessionScrollPosition('measured-case', false, { messageId: 'm2', offsetTop: -80 });

        expect(readSessionScrollPosition('measured-case')).toEqual({ messageId: 'm2', offsetTop: -80 });
    });

    test('a session left at its end still forgets the earlier position', () => {
        rememberSessionScrollPosition('end-outgoing', { messageId: 'm1', offsetTop: -20 });

        rememberOutgoingSessionScrollPosition('end-outgoing', true, null);

        expect(readSessionScrollPosition('end-outgoing')).toBeNull();
    });
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
