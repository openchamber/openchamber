import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const packageDirectory = dirname(requireUI.resolve('@legendapp/list/react'));
const bundles = ['react.js', 'react.mjs', 'react-native.web.js', 'react-native.web.mjs'];

// Runs the installed dependency's own DOM-order hook (the Bun patch lives in
// it) with a fake clock, timers and list context. The hook moves rows so the
// DOM order matches the item order, and moving a row restyles its subtree.
function domOrderHook(bundle) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function useDOMOrder(ref) {');
    const end = source.indexOf('function useFreshDataTransitionVisibility', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's useDOMOrder implementation");

    let now = 10_000;
    const timers = [];
    const listeners = new Map();
    const sorts = [];
    const ctx = { state: { scrollTime: 0 }, viewRefs: new Map() };
    const container = { isConnected: true, moveBefore() {}, children: [] };
    const effects = [];
    const hooks = { useEffect: (effect) => effects.push(effect) };
    const useDOMOrder = runInNewContext(`(${source.slice(start, end).trim()})`, {
        React3: hooks,
        React3__namespace: hooks,
        useEffect: hooks.useEffect,
        useStateContext: () => ctx,
        listen$: (_ctx, key, callback) => {
            listeners.set(key, callback);
            return () => listeners.delete(key);
        },
        peek$: () => undefined,
        sortDOMElements: () => sorts.push(now),
        Date: { now: () => now },
        setTimeout: (callback, delay) => {
            timers.push({ at: now + delay, callback });
            return timers.length;
        },
        clearTimeout: (id) => {
            if (id !== undefined) timers[id - 1] = null;
        },
    });
    useDOMOrder({ current: container });
    for (const effect of effects) effect();
    return {
        sorts,
        positionsChanged() {
            listeners.get('lastPositionUpdate')();
        },
        advance(ms) {
            now += ms;
            for (const timer of timers) {
                if (timer && timer.at <= now) {
                    timers[timers.indexOf(timer)] = null;
                    timer.callback();
                }
            }
        },
    };
}

// Runs the installed dependency's own container allocation for the first
// rows of a freshly opened list, with the direction argument its
// calculateItemsInView passes while the initial scroll is active and aligned
// to the end (how the chat opens). Containers render in index order, so the
// returned container per row is the row's DOM position.
function initialAllocation(bundle) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function findAvailableContainers(');
    const end = source.indexOf('// src/utils/setDidLayout.ts', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's container allocation");

    const callStart = source.indexOf('const availableContainerAllocations = findAvailableContainers(');
    const argumentsEnd = source.indexOf(');', callStart);
    assert.ok(callStart >= 0 && argumentsEnd > callStart, 'Find the allocation call in calculateItemsInView');
    const directionArgument = source
        .slice(callStart, argumentsEnd)
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
        .split('protectedContainerKeys,')[1]
        .trim();
    const reverseItemOrder = runInNewContext(directionArgument, {
        hasActiveInitialScroll: () => true,
        initialScroll: { index: 9, viewPosition: 1 },
        speed: 0,
        state: { hasScrolled: false, scroll: 0, scrollPrev: 0 },
    });

    const numContainers = 6;
    const values = new Map([['numContainers', numContainers]]);
    const ctx = {
        state: {
            containerItemMetadata: new Map(),
            stickyContainerPool: new Set(),
            props: { data: Array.from({ length: 10 }, (_, index) => index), recycleItems: false, stickyHeaderIndicesSet: new Set() },
            indexByKey: new Map(),
        },
    };
    const findAvailableContainers = runInNewContext(`(() => { ${source.slice(start, end)}; return findAvailableContainers; })()`, {
        peek$: (_ctx, key) => values.get(key),
        IS_DEV: false,
    });
    // The rows on screen at the end of a ten-row list: 6..9, all new.
    const allocations = findAvailableContainers(ctx, [6, 7, 8, 9], 6, 9, [], undefined, reverseItemOrder);
    return allocations.map(({ itemIndex, containerIndex }) => ({ itemIndex, containerIndex }));
}

for (const bundle of bundles) {
    describe(`LegendList DOM order: ${bundle}`, () => {
        it('opens an end-aligned list with its rows already in DOM order', () => {
            const allocations = initialAllocation(bundle);
            const byContainer = [...allocations].sort((left, right) => left.containerIndex - right.containerIndex);
            assert.deepEqual(byContainer.map(({ itemIndex }) => itemIndex), [6, 7, 8, 9]);
        });

        it('waits for a freshly mounted list to settle before moving rows', () => {
            const list = domOrderHook(bundle);
            list.advance(200);
            list.positionsChanged();
            list.advance(100);
            assert.deepEqual(list.sorts, []);
            list.advance(400);
            assert.equal(list.sorts.length, 1);
        });

        it('still orders a list that has been quiet for a second at once', () => {
            const list = domOrderHook(bundle);
            list.advance(1_500);
            list.positionsChanged();
            list.advance(0);
            assert.equal(list.sorts.length, 1);
        });
    });
}
