import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findRatchetViolations } from './check-changed.mjs';

const counts = (entries) => new Map(entries.map(([file, rule, count]) => [`${file}\0${rule}`, count]));

test('old findings may stay or shrink', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]])), []);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 1]])), []);
});

test('code moved into a new shared file is not new', () => {
  const base = counts([['a.js', 'anti-slop(no-runtime-typeof)', 2], ['b.js', 'anti-slop(no-runtime-typeof)', 2]]);
  const current = counts([['shared.js', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, current), []);
});

test('a rule that grows across the change is a violation, naming the files it grew in', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3], ['a.ts', 'anti-slop(no-unknown-returns)', 2]]);
  const current = counts([
    ['a.ts', 'anti-slop(no-runtime-typeof)', 1],
    ['a.ts', 'anti-slop(no-unknown-returns)', 2],
    ['new.ts', 'anti-slop(no-unknown-returns)', 1],
  ]);
  assert.deepEqual(findRatchetViolations(base, current), [
    { rule: 'anti-slop(no-unknown-returns)', base: 2, current: 3, files: ['new.ts'] },
  ]);
});
