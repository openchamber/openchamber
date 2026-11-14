import { describe, expect, test } from 'bun:test';

import { livePageAsk } from './usePageAsk';

describe('livePageAsk', () => {
    test('an announced wait stands whatever the session status says', () => {
        expect(livePageAsk({ kind: 'waiting' }, true, false)).toEqual({ kind: 'waiting' });
        // The session's status can lag behind the announcement.
        expect(livePageAsk({ kind: 'waiting' }, true, true)).toEqual({ kind: 'waiting' });
    });

    test('a call left running in a session that no longer runs was not answered', () => {
        expect(livePageAsk({ kind: 'waiting' }, false, true)).toEqual({ kind: 'unanswered' });
    });

    test('a wait not announced yet stands while the session is not known to be idle', () => {
        expect(livePageAsk({ kind: 'waiting' }, false, false)).toEqual({ kind: 'waiting' });
    });

    test('a settled page keeps what its call stored', () => {
        const answered = { kind: 'answered', summary: 'Red', data: null } as const;
        expect(livePageAsk(answered, false, true)).toBe(answered);
        expect(livePageAsk({ kind: 'declined' }, false, true)).toEqual({ kind: 'declined' });
    });
});
