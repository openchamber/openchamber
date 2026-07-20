import { describe, expect, test } from 'bun:test';

import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';
import { isBranchDiffAvailable, loadBranchDiff, mapBranchDiffEntries } from './branchDiff';

describe('getFirstChangedModifiedLineFromPatch', () => {
  test('returns the first added line instead of the hunk context start', () => {
    expect(getFirstChangedModifiedLineFromPatch(`diff --git a/src/file.ts b/src/file.ts
@@ -56,10 +56,11 @@
 unchanged 58
 unchanged 59
 unchanged 60
+changed 61
 unchanged 62`)).toBe(59);
  });

  test('returns the following modified line for deletion-only hunks', () => {
    expect(getFirstChangedModifiedLineFromPatch(`@@ -10,4 +10,3 @@
 context
-removed
 after`)).toBe(11);
  });

  test('returns null when the patch has no hunk change lines', () => {
    expect(getFirstChangedModifiedLineFromPatch('Binary files a/image.png and b/image.png differ')).toBeNull();
  });
});

describe('branch diff scope', () => {
  test('is available only on a feature branch with a known default branch', () => {
    expect(isBranchDiffAvailable({ branch: 'feature', default_branch: 'trunk' })).toBe(true);
    expect(isBranchDiffAvailable({ branch: 'trunk', default_branch: 'trunk' })).toBe(false);
    expect(isBranchDiffAvailable({ branch: 'feature' })).toBe(false);
    expect(isBranchDiffAvailable({ default_branch: 'trunk' })).toBe(false);
  });

  test('requests the branch diff with bounded context and preserves an empty success', async () => {
    const requests: unknown[] = [];
    const result = await loadBranchDiff(async (input) => {
      requests.push(input);
      return { data: [] };
    }, '/workspace/openchamber');

    expect(requests).toEqual([{
      mode: 'branch',
      context: 3,
      directory: '/workspace/openchamber',
    }]);
    expect(result).toEqual([]);
  });

  test('surfaces SDK failures instead of treating them as an empty diff', async () => {
    expect(loadBranchDiff(async () => ({
      error: { message: 'merge base unavailable' },
      response: { status: 500 },
    }), '/workspace/openchamber')).rejects.toThrow('Branch diff failed (500): merge base unavailable');

    expect(loadBranchDiff(async () => ({}), '/workspace/openchamber')).rejects.toThrow('Branch diff failed: empty response');
  });

  test('maps branch status and totals into read-only stacked entries', () => {
    const entries = mapBranchDiffEntries([
      { file: 'src/added.ts', status: 'added', additions: 4, deletions: 0, patch: '@@ -0,0 +1 @@\n+new' },
      { file: 'src/deleted.ts', status: 'deleted', additions: 0, deletions: 3, patch: '@@ -1 +0,0 @@\n-old' },
      { file: 'src/modified.ts', status: 'modified', additions: 2, deletions: 1 },
    ]);

    expect(entries).toEqual([
      {
        path: 'src/added.ts',
        index: '',
        working_dir: 'A',
        insertions: 4,
        deletions: 0,
        isNew: true,
        patch: '@@ -0,0 +1 @@\n+new',
        readOnly: true,
      },
      {
        path: 'src/deleted.ts',
        index: '',
        working_dir: 'D',
        insertions: 0,
        deletions: 3,
        isNew: false,
        patch: '@@ -1 +0,0 @@\n-old',
        readOnly: true,
      },
      {
        path: 'src/modified.ts',
        index: '',
        working_dir: 'M',
        insertions: 2,
        deletions: 1,
        isNew: false,
        patch: null,
        readOnly: true,
      },
    ]);
  });

  test('marks capped header-only patches as unavailable instead of rendering a blank diff', () => {
    const [entry] = mapBranchDiffEntries([{
      file: 'src/large.ts',
      status: 'modified',
      additions: 500_000,
      deletions: 500_000,
      patch: 'Index: src/large.ts\n===================================================================\n--- src/large.ts\n+++ src/large.ts\n',
    }]);

    expect(entry?.patch).toBeNull();
    expect(entry?.readOnly).toBe(true);
  });
});
