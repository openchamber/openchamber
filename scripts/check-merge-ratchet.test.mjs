import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findMergeLengthViolations, findMergeRatchetViolations, readTree } from './check-merge-ratchet.mjs';

// Oracle: the gate as the coordinator stated it for upstream syncs. Per rule,
// merged <= fork + upstream - base over every file either side changed; a file
// over 800 lines may not exceed its larger parent plus the fork's own additions.

const totals = (entries) => new Map(entries);
const RULE = 'anti-slop(no-runtime-typeof)';

test('findings either parent added are allowed, and only what the merge adds is over', () => {
  const sides = { base: totals([[RULE, 10]]), fork: totals([[RULE, 13]]), upstream: totals([[RULE, 12]]) };
  const [exact] = findMergeRatchetViolations({ ...sides, merged: totals([[RULE, 15]]) });
  assert.deepEqual(exact, { rule: RULE, base: 10, fork: 13, upstream: 12, allowed: 15, merged: 15 });
  const [over] = findMergeRatchetViolations({ ...sides, merged: totals([[RULE, 16]]) });
  assert.equal(over.merged > over.allowed, true);
});

test('findings either side removed lower the allowance', () => {
  const [row] = findMergeRatchetViolations({
    base: totals([[RULE, 10]]), fork: totals([[RULE, 10]]), upstream: totals([[RULE, 4]]), merged: totals([[RULE, 10]]),
  });
  assert.equal(row.allowed, 4);
  assert.equal(row.merged > row.allowed, true);
});

test('a rule only the merged tree reports is over from its first finding', () => {
  const [row] = findMergeRatchetViolations({ base: totals([]), fork: totals([]), upstream: totals([]), merged: totals([[RULE, 1]]) });
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
