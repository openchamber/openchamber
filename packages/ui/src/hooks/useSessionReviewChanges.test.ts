import { describe, expect, test } from 'bun:test';

import type { SessionMessageTarget } from '@/sync/session-message-loader';

import { retainReviewHistories } from './useSessionReviewChanges';

type RetainReason = 'read' | 'rendered';

const fakeLoader = () => {
    const order: string[] = [];
    const retained: Array<{ target: SessionMessageTarget; reason: RetainReason }> = [];
    const released: string[] = [];
    const loader = {
        ensure: (target: SessionMessageTarget): Promise<void> => {
            order.push(`ensure:${target.sessionID}`);
            return Promise.resolve();
        },
        retainSessionHistory: (target: SessionMessageTarget, reason: RetainReason = 'read'): (() => void) => {
            retained.push({ target, reason });
            order.push(`retain:${target.sessionID}`);
            return () => { released.push(target.sessionID); };
        },
    };
    return { loader, order, retained, released };
};

describe('retainReviewHistories', () => {
    test('holds every descendant before loading it, then releases every hold', () => {
        const { loader, order, retained, released } = fakeLoader();

        const release = retainReviewHistories(loader, '/repo', ['child-a', 'child-b']);

        expect(retained.map(({ target }) => target.sessionID)).toEqual(['child-a', 'child-b']);
        expect(retained.every(({ reason }) => reason === 'read')).toBe(true);
        expect(retained.every(({ target }) => target.directory === '/repo')).toBe(true);
        // The hold must precede the load: a cache cleanup pass scheduled by the
        // load has to see it, or the child can be evicted as soon as it arrives.
        expect(order).toEqual([
            'retain:child-a',
            'retain:child-b',
            'ensure:child-a',
            'ensure:child-b',
        ]);

        release();
        expect(released).toEqual(['child-a', 'child-b']);
    });

    test('does nothing for an empty descendant list', () => {
        const { loader, order } = fakeLoader();

        const release = retainReviewHistories(loader, '/repo', []);

        expect(order).toEqual([]);
        release();
        expect(order).toEqual([]);
    });
});
