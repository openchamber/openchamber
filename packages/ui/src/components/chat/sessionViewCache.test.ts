import { describe, expect, test } from 'bun:test';

import {
    applySessionViewSelectionIntent,
    commitMaterializedSessionView,
    createSessionViewKey,
    createSessionViewRenderIntent,
    materializeSessionViewRenderIntent,
    recordSessionViewEstimate,
    reconcileSessionViewCache,
    resolveActiveSessionViewKey,
    updateSessionViewEstimate,
    type SessionViewCacheEntry,
    type SessionViewCacheLimits,
    type SessionViewRenderState,
} from './sessionViewCache';

const limits = (maxEntries: number, maxEstimatedBytes: number): SessionViewCacheLimits => ({
    maxEntries,
    maxEstimatedBytes,
});

const selection = (sessionId: string, directory: string, runtimeKey = 'runtime-a') => ({
    runtimeKey,
    sessionId,
    directory,
});

describe('sessionViewCache', () => {
    test('includes the directory in the cache key', () => {
        expect(createSessionViewKey(selection('session-1', '/repo/a')))
            .not.toBe(createSessionViewKey(selection('session-1', '/repo/b')));
    });

    test('includes the runtime identity in the cache key', () => {
        expect(createSessionViewKey(selection('session-1', '/repo', 'runtime-a')))
            .not.toBe(createSessionViewKey(selection('session-1', '/repo', 'runtime-b')));
    });

    test('reuses the same entry and promotes it on A → B → A', () => {
        const cacheLimits = limits(4, 64);
        const withA = reconcileSessionViewCache([], selection('a', '/repo'), cacheLimits, 8);
        const aEntry = withA[0];
        const withB = reconcileSessionViewCache(withA, selection('b', '/repo'), cacheLimits, 8);
        const revisitedA = reconcileSessionViewCache(withB, selection('a', '/repo'), cacheLimits, 8);

        expect(revisitedA.map((entry) => entry.sessionId)).toEqual(['b', 'a']);
        expect(revisitedA[1]).toBe(aEntry);
    });

    test('evicts the least recently used inactive view at the count limit', () => {
        const cacheLimits = limits(2, 64);
        let entries: SessionViewCacheEntry[] = [];
        entries = reconcileSessionViewCache(entries, selection('a', '/repo'), cacheLimits, 8);
        entries = reconcileSessionViewCache(entries, selection('b', '/repo'), cacheLimits, 8);
        entries = reconcileSessionViewCache(entries, selection('c', '/repo'), cacheLimits, 8);

        expect(entries.map((entry) => entry.sessionId)).toEqual(['b', 'c']);
    });

    test('evicts by estimated bytes even when the count limit is not reached', () => {
        const cacheLimits = limits(4, 16);
        let entries: SessionViewCacheEntry[] = [];
        entries = reconcileSessionViewCache(entries, selection('a', '/repo'), cacheLimits, 8);
        entries = reconcileSessionViewCache(entries, selection('b', '/repo'), cacheLimits, 8);
        entries = reconcileSessionViewCache(entries, selection('c', '/repo'), cacheLimits, 8);

        expect(entries.map((entry) => entry.sessionId)).toEqual(['b', 'c']);
    });

    test('a larger active estimate evicts old views but never evicts the active view', () => {
        const cacheLimits = limits(4, 16);
        let entries: SessionViewCacheEntry[] = [];
        entries = reconcileSessionViewCache(entries, selection('a', '/repo'), cacheLimits, 4);
        entries = reconcileSessionViewCache(entries, selection('b', '/repo'), cacheLimits, 4);
        const activeKey = createSessionViewKey(selection('b', '/repo'));

        entries = updateSessionViewEstimate(entries, activeKey, 20, activeKey, cacheLimits);

        expect(entries.map((entry) => entry.sessionId)).toEqual(['b']);
        expect(entries[0]?.estimatedBytes).toBe(20);
    });

    test('preserves the cache array when an estimate is unchanged', () => {
        const cacheLimits = limits(4, 64);
        const entries = reconcileSessionViewCache([], selection('a', '/repo'), cacheLimits, 8);
        const activeKey = createSessionViewKey(selection('a', '/repo'));

        const unchanged = updateSessionViewEstimate(entries, activeKey, 8, activeKey, cacheLimits);

        expect(unchanged).toBe(entries);
    });

    test('stale materialization intents cannot become visible or pollute the LRU', () => {
        const cacheLimits = limits(2, 64);
        const a = selection('a', '/repo');
        const bIntent = createSessionViewRenderIntent(selection('b', '/repo'));
        const cIntent = createSessionViewRenderIntent(selection('c', '/repo'));
        const initial: SessionViewRenderState = {
            activeIntent: createSessionViewRenderIntent(a),
            cacheNeedsTrim: false,
            cachedSessionViews: reconcileSessionViewCache([], a, cacheLimits, 8),
            pendingSessionView: null,
        };

        const selectedB = applySessionViewSelectionIntent(initial, bIntent, cacheLimits);
        const stagedB = materializeSessionViewRenderIntent(selectedB, bIntent, bIntent, 8);
        const selectedC = applySessionViewSelectionIntent(stagedB, cIntent, cacheLimits);
        expect(selectedC.activeIntent).toBe(cIntent);
        expect(selectedC.pendingSessionView).toBeNull();
        expect(resolveActiveSessionViewKey(selectedC.cachedSessionViews, cIntent.key)).toBeNull();

        const staleB = materializeSessionViewRenderIntent(selectedC, bIntent, cIntent, 8);
        expect(staleB).toBe(selectedC);
        expect(commitMaterializedSessionView(selectedC, bIntent, cacheLimits)).toBe(selectedC);

        const stagedC = materializeSessionViewRenderIntent(selectedC, cIntent, cIntent, 8);
        expect(stagedC.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['a']);
        expect(stagedC.pendingSessionView?.entry.sessionId).toBe('c');

        const committedC = commitMaterializedSessionView(stagedC, cIntent, cacheLimits);
        expect(committedC.activeIntent).toBe(cIntent);
        expect(committedC.pendingSessionView).toBeNull();
        expect(committedC.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['a', 'c']);
        expect(resolveActiveSessionViewKey(committedC.cachedSessionViews, cIntent.key)).toBe(cIntent.key);

        const lateB = materializeSessionViewRenderIntent(committedC, bIntent, cIntent, 8);
        expect(lateB).toBe(committedC);
        expect(lateB.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['a', 'c']);
    });

    test('intent identity rejects a stale A after A -> B -> A', () => {
        const a = selection('a', '/repo');
        const firstAIntent = createSessionViewRenderIntent(a);
        const secondAIntent = createSessionViewRenderIntent(a);
        const current: SessionViewRenderState = {
            activeIntent: secondAIntent,
            cacheNeedsTrim: false,
            cachedSessionViews: [],
            pendingSessionView: null,
        };

        expect(materializeSessionViewRenderIntent(
            current,
            firstAIntent,
            secondAIntent,
            8,
        )).toBe(current);
    });

    test('latest intent rejects a stale updater rebased over its historical matching state', () => {
        const aIntent = createSessionViewRenderIntent(selection('a', '/repo'));
        const bIntent = createSessionViewRenderIntent(selection('b', '/repo'));
        const historicalBState: SessionViewRenderState = {
            activeIntent: bIntent,
            cacheNeedsTrim: false,
            cachedSessionViews: [],
            pendingSessionView: null,
        };

        expect(materializeSessionViewRenderIntent(
            historicalBState,
            bIntent,
            aIntent,
            8,
        )).toBe(historicalBState);
    });

    test('a cache hit becomes active immediately and promotes the existing view', () => {
        const cacheLimits = limits(4, 64);
        const a = selection('a', '/repo');
        const b = selection('b', '/repo');
        const bIntent = createSessionViewRenderIntent(b);
        const initial: SessionViewRenderState = {
            activeIntent: createSessionViewRenderIntent(a),
            cacheNeedsTrim: false,
            cachedSessionViews: reconcileSessionViewCache(
                reconcileSessionViewCache([], b, cacheLimits, 8),
                a,
                cacheLimits,
                8,
            ),
            pendingSessionView: null,
        };

        const selectedB = applySessionViewSelectionIntent(initial, bIntent, cacheLimits);

        expect(selectedB.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['a', 'b']);
        expect(resolveActiveSessionViewKey(selectedB.cachedSessionViews, bIntent.key)).toBe(bIntent.key);
    });

    test('estimate replay trims against the latest selected view', () => {
        const cacheLimits = limits(4, 16);
        const a = selection('a', '/repo');
        const b = selection('b', '/repo');
        const aIntent = createSessionViewRenderIntent(a);
        const cachedSessionViews = reconcileSessionViewCache(
            reconcileSessionViewCache([], a, cacheLimits, 4),
            b,
            cacheLimits,
            4,
        );
        const bKey = createSessionViewKey(b);
        const recorded = recordSessionViewEstimate(cachedSessionViews, bKey, 20);
        const replayedEstimate: SessionViewRenderState = {
            activeIntent: aIntent,
            cacheNeedsTrim: true,
            cachedSessionViews: recorded,
            pendingSessionView: null,
        };

        const trimmed = applySessionViewSelectionIntent(replayedEstimate, aIntent, cacheLimits);

        expect(trimmed.cacheNeedsTrim).toBe(false);
        expect(trimmed.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['a']);
    });

    test('reapplies tighter cache limits when the active intent is unchanged', () => {
        const wideLimits = limits(4, 64);
        const tightLimits = limits(2, 64);
        const a = selection('a', '/repo');
        const b = selection('b', '/repo');
        const c = selection('c', '/repo');
        const cIntent = createSessionViewRenderIntent(c);
        const initial: SessionViewRenderState = {
            activeIntent: cIntent,
            cacheNeedsTrim: false,
            cachedSessionViews: reconcileSessionViewCache(
                reconcileSessionViewCache(
                    reconcileSessionViewCache([], a, wideLimits, 8),
                    b,
                    wideLimits,
                    8,
                ),
                c,
                wideLimits,
                8,
            ),
            pendingSessionView: null,
        };

        const constrained = applySessionViewSelectionIntent(initial, cIntent, tightLimits);

        expect(constrained).not.toBe(initial);
        expect(constrained.activeIntent).toBe(cIntent);
        expect(constrained.cachedSessionViews.map((entry) => entry.sessionId)).toEqual(['b', 'c']);
    });
});
