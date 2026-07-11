import { describe, expect, test } from "bun:test";
import { extractHunkPatch, splitPatchIntoHunks } from "./patchFileDiff";

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
