import { describe, expect, test } from 'bun:test';
import { branchActionFor } from './branchAction';

const open = { state: 'open', draft: false };
const both = { updateBranch: true, rebase: true };
const updateOnly = { updateBranch: true, rebase: false };
const rebaseOnly = { updateBranch: false, rebase: true };
const neither = { updateBranch: false, rebase: false };

describe('the branch action under the item', () => {
    test('asks for the operation the host declares', () => {
        expect(branchActionFor(open, updateOnly)).toBe('update');
        expect(branchActionFor(open, rebaseOnly)).toBe('rebase');
        expect(branchActionFor(open, both)).toBe('update');
        expect(branchActionFor(open, neither)).toBeNull();
    });

    test('is absent on a draft, a closed or a merged change request', () => {
        for (const pull of [{ state: 'open', draft: true }, { state: 'closed', draft: false }, { state: 'merged', draft: false }]) {
            expect(branchActionFor(pull, updateOnly)).toBeNull();
        }
        expect(branchActionFor(null, updateOnly)).toBeNull();
    });

    test('is absent where the account may not write, or where a merge is already in flight', () => {
        expect(branchActionFor(open, updateOnly, { writeAccess: false })).toBeNull();
        expect(branchActionFor(open, updateOnly, { writeAccess: true })).toBe('update');
        expect(branchActionFor(open, updateOnly, { waitingMerge: true })).toBeNull();
    });
});
