import { describe, expect, test } from 'bun:test';

import { laterPageAsk, livePageAsk } from './usePageAsk';

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

describe('laterPageAsk', () => {
    const page = { sessionID: 'ses_1', callID: 'call_1' };

    test('an open page takes an answer like a waiting one, after its call ended', () => {
        expect(laterPageAsk({ ...page, status: 'open' })).toEqual({ kind: 'waiting', later: true });
    });

    test('a settled page shows what the user did on any client', () => {
        expect(laterPageAsk({ ...page, status: 'answered', summary: 'Red', data: { color: 'red' } }))
            .toEqual({ kind: 'answered', summary: 'Red', data: { color: 'red' } });
        expect(laterPageAsk({ ...page, status: 'declined' })).toEqual({ kind: 'declined' });
        expect(laterPageAsk({ ...page, status: 'ui-not-drawn' })).toEqual({ kind: 'not-drawn' });
    });

    test('an answer the agent has not got yet says so', () => {
        expect(laterPageAsk({ ...page, status: 'answered', summary: 'Red', undelivered: true }))
            .toEqual({ kind: 'answered', summary: 'Red', data: null, undelivered: true });
        expect(laterPageAsk({ ...page, status: 'declined', undelivered: true })).toEqual({ kind: 'declined', undelivered: true });
    });

    test('a page the server does not keep is shown without asking', () => {
        expect(laterPageAsk(undefined)).toEqual({ kind: 'show' });
    });
});
