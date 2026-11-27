import { describe, expect, test } from 'bun:test';
import { branchActionPayload, branchActionsFor } from './branchAction';

const open = { state: 'open', draft: false };
const both = { updateBranch: true, rebase: true };
const updateOnly = { updateBranch: true, rebase: false };
const rebaseOnly = { updateBranch: false, rebase: true };
const neither = { updateBranch: false, rebase: false };

describe('the branch actions under the item', () => {
    const allowed = { branchWriteAccess: true };

    test('lists the operations the host declares, update first', () => {
        expect(branchActionsFor(open, both, allowed)).toEqual(['update', 'rebase']);
        expect(branchActionsFor(open, updateOnly, allowed)).toEqual(['update']);
        expect(branchActionsFor(open, rebaseOnly, allowed)).toEqual(['rebase']);
        expect(branchActionsFor(open, neither, allowed)).toEqual([]);
    });

    test('is absent on a draft, a closed or a merged change request', () => {
        for (const pull of [{ state: 'open', draft: true }, { state: 'closed', draft: false }, { state: 'merged', draft: false }]) {
            expect(branchActionsFor(pull, both)).toEqual([]);
        }
        expect(branchActionsFor(null, both)).toEqual([]);
    });

    test('is absent while a merge is already in flight', () => {
        expect(branchActionsFor(open, both, { waitingMerge: true, branchWriteAccess: true })).toEqual([]);
        expect(branchActionsFor(open, both, { waitingMerge: false, branchWriteAccess: true })).toEqual(['update', 'rebase']);
    });

    test('waits for the read to report branch write access before listing anything', () => {
        expect(branchActionsFor(open, both, {})).toEqual([]);
        expect(branchActionsFor(open, both, { branchWriteAccess: undefined })).toEqual([]);
        expect(branchActionsFor(open, both, { branchWriteAccess: false })).toEqual([]);
        expect(branchActionsFor(open, both, { branchWriteAccess: true })).toEqual(['update', 'rebase']);
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
