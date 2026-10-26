import { describe, expect, it } from 'vitest';
import { parseDiffFiles, indexHunks, listHunkIds } from './hunks.js';

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;
@@ -20,2 +21,2 @@
-const old = true;
+const next = true;
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

describe('parseDiffFiles', () => {
  it('splits files and hunks with line ranges and counts', () => {
    const { files } = parseDiffFiles(TWO_FILE_DIFF, 'working');

    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      added: 1,
      deleted: 0,
    });
    expect(files[0].hunks[1]).toMatchObject({ added: 1, deleted: 1 });
    expect(files[1].status).toBe('added');
    expect(files[1].hunks[0]).toMatchObject({ added: 2, deleted: 0 });
  });

  it('produces a standalone applicable patch per hunk', () => {
    const { files } = parseDiffFiles(TWO_FILE_DIFF, 'working');
    const patch = files[0].hunks[1].patch;

    expect(patch.startsWith('diff --git a/src/a.ts b/src/a.ts')).toBe(true);
    expect(patch).toContain('--- a/src/a.ts');
    expect(patch).toContain('+++ b/src/a.ts');
    expect((patch.match(/^@@/gm) || [])).toHaveLength(1);
    expect(patch).toContain('+const next = true;');
    expect(patch).not.toContain('const b = 2;');
  });

  it('keeps ids stable across reparses of identical input', () => {
    const first = listHunkIds(parseDiffFiles(TWO_FILE_DIFF, 'working').files);
    const second = listHunkIds(parseDiffFiles(TWO_FILE_DIFF, 'working').files);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it('keeps an untouched hunk addressable when a neighbour changes', () => {
    const before = parseDiffFiles(TWO_FILE_DIFF, 'working').files[0].hunks;
    const edited = TWO_FILE_DIFF.replace('+const next = true;', '+const next = false;');
    const after = parseDiffFiles(edited, 'working').files[0].hunks;

    // The unrelated first hunk survives; only the edited one loses its id.
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
  });

  it('separates identical hunks in different scopes', () => {
    const staged = parseDiffFiles(TWO_FILE_DIFF, 'staged').files[0].hunks[0].id;
    const working = parseDiffFiles(TWO_FILE_DIFF, 'working').files[0].hunks[0].id;

    expect(staged).not.toBe(working);
  });

  it('disambiguates byte-identical hunks inside one file', () => {
    const repeated = `diff --git a/src/dup.ts b/src/dup.ts
--- a/src/dup.ts
+++ b/src/dup.ts
@@ -1,1 +1,2 @@
+import { thing } from './thing';
@@ -1,1 +1,2 @@
+import { thing } from './thing';
`;

    const ids = listHunkIds(parseDiffFiles(repeated, 'working').files);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('records renames and deletions', () => {
    const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-const gone = true;
`;

    const { files } = parseDiffFiles(renamed, 'working');

    expect(files[0]).toMatchObject({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' });
    expect(files[1]).toMatchObject({ path: 'src/gone.ts', status: 'deleted' });
  });

  it('marks binary files and gives them no hunks', () => {
    const binary = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

    const { files } = parseDiffFiles(binary, 'working');

    expect(files[0]).toMatchObject({ path: 'logo.png', binary: true });
    expect(files[0].hunks).toHaveLength(0);
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(parseDiffFiles('', 'working').files).toEqual([]);
    expect(parseDiffFiles('   \n', 'working').files).toEqual([]);
    expect(parseDiffFiles(undefined, 'working').files).toEqual([]);
  });
});

describe('indexHunks', () => {
  it('maps every id to its hunk with the owning file path', () => {
    const { files } = parseDiffFiles(TWO_FILE_DIFF, 'working');
    const index = indexHunks(files);

    expect(index.size).toBe(3);
    for (const [id, hunk] of index) {
      expect(hunk.id).toBe(id);
      expect(hunk.path).toBeTruthy();
    }
  });
});
