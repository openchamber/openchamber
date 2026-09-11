import { expect, test } from 'bun:test';
import { parsePullRequestDiff } from './pullRequestDiff';

const modified = 'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+published\n';
const renamed = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
const binary = 'diff --git a/image.png b/image.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/image.png differ\n';
const deleted = 'diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';

test('PR snapshot retains original patches, rename-only, binary, and deleted files', () => {
  const files = parsePullRequestDiff(modified + renamed + binary + deleted);
  expect(files.map(({ path, status, insertions, deletions }) => ({ path, status, insertions, deletions }))).toEqual([
    { path: 'a.ts', status: 'M', insertions: 1, deletions: 1 },
    { path: 'new.ts', status: 'R', insertions: 0, deletions: 0 },
    { path: 'image.png', status: 'A', insertions: 0, deletions: 0 },
    { path: 'deleted.ts', status: 'D', insertions: 0, deletions: 1 },
  ]);
  expect(files.map((file) => file.patch)).toEqual([modified, renamed, binary, deleted]);
  expect(files[1].previousPath).toBe('old.ts');
});

test('a successful empty diff is distinct from a malformed response', () => {
  expect(parsePullRequestDiff('')).toEqual([]);
  expect(() => parsePullRequestDiff('<html>login</html>')).toThrow();
});
