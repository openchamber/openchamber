import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemovalTombstones } from './inlineCommentRemovals';

describe('inline comment removal tombstones', () => {
    test('a delivery arriving after its removal is dropped', () => {
        // The window this closes: the extension holds a payload for a booting
        // panel, or the handler waits for a directory, and the user removes the
        // thread meanwhile. Without this the draft lands as a chip they dropped.
        const tombstones = createRemovalTombstones();
        tombstones.remember('icd-1');
        assert.equal(tombstones.consume('icd-1'), true);
    });

    test('an unrelated delivery is untouched', () => {
        const tombstones = createRemovalTombstones();
        tombstones.remember('icd-1');
        assert.equal(tombstones.consume('icd-2'), false);
    });

    test('a delivery with no id is never dropped', () => {
        // Comments from other entry points carry no draft id.
        const tombstones = createRemovalTombstones();
        tombstones.remember('icd-1');
        assert.equal(tombstones.consume(undefined), false);
    });

    test('the record is consumed, so only the delayed delivery is refused', () => {
        const tombstones = createRemovalTombstones();
        tombstones.remember('icd-1');
        tombstones.consume('icd-1');
        assert.equal(tombstones.consume('icd-1'), false);
        assert.equal(tombstones.size(), 0);
    });

    test('remembering the same removal twice keeps one record', () => {
        const tombstones = createRemovalTombstones();
        tombstones.remember('icd-1');
        tombstones.remember('icd-1');
        assert.equal(tombstones.size(), 1);
    });

    test('an empty id is not recorded', () => {
        const tombstones = createRemovalTombstones();
        tombstones.remember('');
        assert.equal(tombstones.size(), 0);
    });

    test('the record is bounded, evicting the oldest first', () => {
        const tombstones = createRemovalTombstones(3);
        for (const id of ['a', 'b', 'c', 'd']) tombstones.remember(id);

        assert.equal(tombstones.size(), 3);
        // 'a' aged out; the three most recent still refuse their deliveries.
        assert.equal(tombstones.consume('a'), false);
        assert.equal(tombstones.consume('d'), true);
        assert.equal(tombstones.consume('c'), true);
        assert.equal(tombstones.consume('b'), true);
    });
});
