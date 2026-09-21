import { describe, expect, test } from "bun:test";
import { extractHunkPatch, splitPatchIntoHunks, haveMatchingPatchVersions, getPatchHunkAnchors } from "./patchFileDiff";

const SAMPLE_PATCH = `diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,4 +1,5 @@
 line1
+added-top
 line2
 line3
 line4
@@ -10,3 +11,4 @@
 line10
-deleted-mid
 line11
+added-bottom
`;

describe("splitPatchIntoHunks", () => {
  test("splits a multi-hunk patch into standalone per-hunk patches", () => {
    const hunks = splitPatchIntoHunks(SAMPLE_PATCH);
    expect(hunks.length).toBe(2);

    expect(hunks[0]).toContain("diff --git a/foo.txt b/foo.txt");
    expect(hunks[0]).toContain("--- a/foo.txt");
    expect(hunks[0]).toContain("+++ b/foo.txt");
    expect(hunks[0]).toContain("@@ -1,4 +1,5 @@");
    expect(hunks[0]).toContain("+added-top");
    expect(hunks[0]).not.toContain("@@ -10,3 +11,4 @@");
    expect(hunks[0]).not.toContain("added-bottom");

    expect(hunks[1]).toContain("@@ -10,3 +11,4 @@");
    expect(hunks[1]).toContain("-deleted-mid");
    expect(hunks[1]).toContain("+added-bottom");
    expect(hunks[1]).not.toContain("added-top");
  });

  test("each hunk keeps the file header so it applies on its own", () => {
    const hunks = splitPatchIntoHunks(SAMPLE_PATCH);
    for (const hunk of hunks) {
      expect(hunk.startsWith("diff --git a/foo.txt b/foo.txt\n")).toBe(true);
      expect(hunk.match(/^--- a\/foo.txt$/m)).not.toBeNull();
      expect(hunk.match(/^\+\+\+ b\/foo.txt$/m)).not.toBeNull();
      expect(hunk.match(/^@@\s/m)).not.toBeNull();
    }
  });

  test("returns [] for an empty patch or a patch without hunks", () => {
    expect(splitPatchIntoHunks("")).toEqual([]);
    expect(splitPatchIntoHunks("diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n")).toEqual([]);
  });

  test("handles a single-hunk patch", () => {
    const single = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,1 +1,2 @@
 a
+b
`;
    const hunks = splitPatchIntoHunks(single);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toContain("+b");
  });
});

describe("extractHunkPatch", () => {
  test("pairs display and action patches only with identical full blob identities and file headers", () => {
    const patch = (hash: string, file = 'f') => `diff --git a/${file} b/${file}\nindex ${'a'.repeat(40)}..${hash} 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
    const first = patch('b'.repeat(40));
    expect(haveMatchingPatchVersions(first, first)).toBe(true);
    expect(haveMatchingPatchVersions(first, patch('c'.repeat(40)))).toBe(false);
    expect(haveMatchingPatchVersions(first, patch('b'.repeat(40), 'other'))).toBe(false);
    expect(haveMatchingPatchVersions(SAMPLE_PATCH, SAMPLE_PATCH)).toBe(false);
  });
  test("preserves CRLF content and mixed endings byte for byte", () => {
    const header = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n';
    const first = '@@ -1,2 +1,2 @@\n-before\r\n+after\r\n context\n';
    const second = '@@ -20 +20 @@\n-old\n+new\r\n';
    expect(splitPatchIntoHunks(header + first + second)).toEqual([header + first, header + second]);
    expect(extractHunkPatch(header + first + second, 1)).toBe(header + second);
  });

  test("returns the standalone patch for the requested index", () => {
    const second = extractHunkPatch(SAMPLE_PATCH, 1);
    expect(second).not.toBeNull();
    expect(second).toContain("@@ -10,3 +11,4 @@");
    expect(second).toContain("diff --git a/foo.txt b/foo.txt");
  });

  test("returns null for out-of-range or invalid indices", () => {
    expect(extractHunkPatch(SAMPLE_PATCH, -1)).toBeNull();
    expect(extractHunkPatch(SAMPLE_PATCH, 2)).toBeNull();
    expect(extractHunkPatch(SAMPLE_PATCH, 1.5)).toBeNull();
    expect(extractHunkPatch("", 0)).toBeNull();
  });
});

describe('hunk action anchors', () => {
  const header = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n';
  test('anchors below trailing deletions rather than above them on the shorter new side', () => {
    expect(getPatchHunkAnchors(header + '@@ -8,5 +8,3 @@\n line8\n line9\n line10\n-gone11\n-gone12\n')).toEqual([
      { index: 0, side: 'deletions', lineNumber: 12 },
    ]);
  });
  test('anchors before trailing context and preserves canonical hunk indices', () => {
    expect(getPatchHunkAnchors(header + '@@ -1,2 +1,2 @@\n-old\n+new\n context\n@@ -20 +20 @@\n-before\n+after\n')).toEqual([
      { index: 0, side: 'additions', lineNumber: 1 },
      { index: 1, side: 'additions', lineNumber: 20 },
    ]);
  });
  test('supports added and fully deleted files with an empty opposite side', () => {
    expect(getPatchHunkAnchors(header + '@@ -0,0 +1,2 @@\n+a\n+b\n')).toEqual([{ index: 0, side: 'additions', lineNumber: 2 }]);
    expect(getPatchHunkAnchors(header + '@@ -1,2 +0,0 @@\n-a\n-b\n')).toEqual([{ index: 0, side: 'deletions', lineNumber: 2 }]);
  });
  test('ignores no-newline metadata when selecting the final row', () => {
    expect(getPatchHunkAnchors(header + '@@ -1 +1 @@\n-before\r\n+after\r\n\\ No newline at end of file\n')).toEqual([
      { index: 0, side: 'additions', lineNumber: 1 },
    ]);
  });
  test('does not create controls for an empty or malformed patch', () => {
    expect(getPatchHunkAnchors('')).toEqual([]);
    expect(getPatchHunkAnchors(header + '@@ -0,0 +0,0 @@\n')).toEqual([]);
  });
});
