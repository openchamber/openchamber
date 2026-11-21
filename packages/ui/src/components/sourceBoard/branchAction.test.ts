import { describe, expect, test } from 'bun:test';
import { branchActionPayload, branchActionsFor } from './branchAction';

const open = { state: 'open', draft: false };
const both = { updateBranch: true, rebase: true };
const updateOnly = { updateBranch: true, rebase: false };
const rebaseOnly = { updateBranch: false, rebase: true };
const neither = { updateBranch: false, rebase: false };

describe('the branch actions under the item', () => {
    test('lists the operations the host declares, update first', () => {
        expect(branchActionsFor(open, both)).toEqual(['update', 'rebase']);
        expect(branchActionsFor(open, updateOnly)).toEqual(['update']);
        expect(branchActionsFor(open, rebaseOnly)).toEqual(['rebase']);
        expect(branchActionsFor(open, neither)).toEqual([]);
    });

    test('keeps the two controls distinct and in a stable order', () => {
        const actions = branchActionsFor(open, both);
        expect(actions).toHaveLength(2);
        expect(new Set(actions).size).toBe(2);
        expect(actions[0]).toBe('update');
        expect(actions[1]).toBe('rebase');
    });

    test('is absent on a draft, a closed or a merged change request', () => {
        for (const pull of [{ state: 'open', draft: true }, { state: 'closed', draft: false }, { state: 'merged', draft: false }]) {
            expect(branchActionsFor(pull, both)).toEqual([]);
        }
        expect(branchActionsFor(null, both)).toEqual([]);
    });

    test('is absent where the account may not write, or where a merge is already in flight', () => {
        expect(branchActionsFor(open, both, { writeAccess: false })).toEqual([]);
        expect(branchActionsFor(open, both, { writeAccess: true })).toEqual(['update', 'rebase']);
        expect(branchActionsFor(open, both, { waitingMerge: true })).toEqual([]);
    });
});

describe('branch action payload', () => {
    test('carries the head SHA the picker saw, for both operations', () => {
        const pull = { number: 2, headSha: 'a'.repeat(40), sourceRepo: { owner: 'acme', repo: 'app' } };
        expect(branchActionPayload(pull)).toEqual({
            target: { project: { owner: 'acme', name: 'app' }, number: 2 },
            expectedHeadSha: 'a'.repeat(40),
        });
    });

    test('reflects a head that moved since the preview loaded', () => {
        expect(branchActionPayload({ number: 2, headSha: 'b'.repeat(40), sourceRepo: { owner: 'acme', repo: 'app' } }).expectedHeadSha)
            .toBe('b'.repeat(40));
    });
});
