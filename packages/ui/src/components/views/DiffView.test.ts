import { describe, expect, test } from 'bun:test';

import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';

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
