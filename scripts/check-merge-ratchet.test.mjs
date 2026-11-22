import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findMergeLengthViolations, findMergeRatchetViolations, readTree } from './check-merge-ratchet.mjs';

// Oracle: the gate as the coordinator stated it for upstream syncs. Per rule,
// merged <= the sum of each file's max(0, fork + upstream - base) over every
// file either side changed; a file
// over 800 lines may not exceed its larger parent plus the fork's own additions.

const counts = (entries) => new Map(entries.map(([file, rule, count]) => [`${file}\0${rule}`, count]));
const RULE = 'anti-slop(no-runtime-typeof)';
const none = counts([]);

test('findings either parent added are allowed, and only what the merge adds is over', () => {
  const sides = { base: counts([['a.ts', RULE, 10]]), fork: counts([['a.ts', RULE, 13]]), upstream: counts([['a.ts', RULE, 12]]) };
  const [exact] = findMergeRatchetViolations({ ...sides, merged: counts([['a.ts', RULE, 15]]) });
  assert.deepEqual(exact, { rule: RULE, base: 10, fork: 13, upstream: 12, allowed: 15, merged: 15 });
  const [over] = findMergeRatchetViolations({ ...sides, merged: counts([['a.ts', RULE, 16]]) });
  assert.equal(over.merged > over.allowed, true);
});

test('findings either side removed lower the allowance', () => {
  const [row] = findMergeRatchetViolations({
    base: counts([['a.ts', RULE, 10]]), fork: counts([['a.ts', RULE, 10]]), upstream: counts([['a.ts', RULE, 4]]), merged: counts([['a.ts', RULE, 10]]),
  });
  assert.equal(row.allowed, 4);
  assert.equal(row.merged > row.allowed, true);
});

test('a path both sides moved away does not take its base findings off other files', () => {
  const [row] = findMergeRatchetViolations({
    base: counts([['old.js', RULE, 41]]),
    fork: counts([['fork.js', RULE, 3]]),
    upstream: counts([['new.ts', RULE, 2]]),
    merged: counts([['fork.js', RULE, 3], ['new.ts', RULE, 2]]),
  });
  assert.deepEqual(row, { rule: RULE, base: 41, fork: 3, upstream: 2, allowed: 5, merged: 5 });
});

test('a rule only the merged tree reports is over from its first finding', () => {
  const [row] = findMergeRatchetViolations({ base: none, fork: none, upstream: none, merged: counts([['a.ts', RULE, 1]]) });
  assert.deepEqual(row, { rule: RULE, base: 0, fork: 0, upstream: 0, allowed: 0, merged: 1 });
});

test('a long file may reach its larger parent plus the fork\'s additions, and no further', () => {
  const file = 'packages/ui/src/sync/store.ts';
  const size = { file, fork: 900, upstream: 1000, forkAdded: 50 };
  assert.deepEqual(findMergeLengthViolations([{ ...size, merged: 1050 }]), []);
  assert.deepEqual(findMergeLengthViolations([{ ...size, merged: 1051 }]).map(({ file: name }) => name), [file]);
});

test('files at or under the limit, tests and declarations have no length allowance to keep', () => {
  const grown = { fork: 100, upstream: 100, forkAdded: 0, merged: 2000 };
  assert.deepEqual(findMergeLengthViolations([
    { ...grown, file: 'packages/ui/src/a.test.ts' },
    { ...grown, file: 'packages/web/server/lib/a.d.ts' },
    { ...grown, file: 'packages/ui/src/b.ts', merged: 800 },
  ]), []);
  assert.equal(findMergeLengthViolations([{ ...grown, file: 'packages/ui/src/b.ts' }]).length, 1);
});

test('reads files at a ref and leaves out the ones the ref lacks', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const known = 'scripts/check-changed.mjs';
  const contents = readTree(head, [known, 'scripts/no-such-file.mjs', 'package.json']);
  assert.deepEqual([...contents.keys()], [known, 'package.json']);
  assert.equal(contents.get('package.json'), execFileSync('git', ['show', `${head}:package.json`], { cwd: root, encoding: 'utf8' }));
  assert.equal(contents.get(known).length > 0, true);
});
