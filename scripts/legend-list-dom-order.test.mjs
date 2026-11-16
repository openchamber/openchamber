import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const packageDirectory = dirname(requireUI.resolve('@legendapp/list/react'));
const bundles = ['react.js', 'react.mjs', 'react-native.web.js', 'react-native.web.mjs'];

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
        viewRefs: new Map(),
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
    });
}
