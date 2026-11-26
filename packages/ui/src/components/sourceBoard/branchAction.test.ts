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

    test('is absent on a draft, a closed or a merged change request', () => {
        for (const pull of [{ state: 'open', draft: true }, { state: 'closed', draft: false }, { state: 'merged', draft: false }]) {
            expect(branchActionsFor(pull, both)).toEqual([]);
        }
        expect(branchActionsFor(null, both)).toEqual([]);
    });

    test('is absent while a merge is already in flight', () => {
        expect(branchActionsFor(open, both, { waitingMerge: true })).toEqual([]);
        expect(branchActionsFor(open, both, { waitingMerge: false })).toEqual(['update', 'rebase']);
    });

    test('is absent only when the viewer is explicitly denied branch write access', () => {
        expect(branchActionsFor(open, both, { branchWriteAccess: false })).toEqual([]);
        expect(branchActionsFor(open, both, { branchWriteAccess: true })).toEqual(['update', 'rebase']);
        expect(branchActionsFor(open, both, {})).toEqual(['update', 'rebase']);
    });
});

describe('branch action payload', () => {
    test('carries the base and head the reader saw, so a retargeted or pushed change request is refused', () => {
        const pull = { number: 2, base: 'main', headSha: 'a'.repeat(40), sourceRepo: { owner: 'acme', repo: 'app' } };
        expect(branchActionPayload(pull)).toEqual({
            target: { project: { owner: 'acme', name: 'app' }, number: 2, base: 'main', headSha: 'a'.repeat(40) },
            expectedHeadSha: 'a'.repeat(40),
        });
    });
});
