import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findOversizedGrowth, findRatchetViolations, parseOxlintReport, parseRenames } from './check-changed.mjs';

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

test('a report with no files to lint is no findings, not a broken gate', () => {
  assert.deepEqual(parseOxlintReport('No files found to lint. Please check your paths and ignore patterns.\n'), []);
  const empty = '{\n  "diagnostics": [],\n  "number_of_files": 0\n}\n';
  assert.deepEqual(parseOxlintReport(`No files found to lint.\n${empty}`), []);
  assert.deepEqual(parseOxlintReport(empty), []);
  assert.throws(() => parseOxlintReport(''), /oxlint produced no report/);
});

test('a renamed file is compared with its old path', () => {
  assert.deepEqual(
    [...parseRenames('R100\told/a.ts\tnew/a.ts\nR087\tb.js\tc.js\n')],
    [['new/a.ts', 'old/a.ts'], ['c.js', 'b.js']],
  );
});

test('an implementation moved behind a rewritten entry keeps its old baseline', () => {
  assert.deepEqual([...parseRenames('M099\tindex.js\nC099\tindex.js\truntime.js\n')], [['runtime.js', 'index.js']]);
  // Copying code while retaining its implementation cannot inherit that baseline.
  assert.deepEqual([...parseRenames('C100\tindex.js\tduplicate.js\n')], []);
  assert.deepEqual([...parseRenames('M\tindex.js\nC099\tindex.js\tduplicate.js\n')], []);
  assert.deepEqual([...parseRenames('M099\tindex.js\nC099\tindex.js\tone.js\nC099\tindex.js\ttwo.js\n')], []);
});

test('a file over the limit cannot be added or grow, and may shrink or stay', () => {
  const size = (file, baseLines, currentLines) => ({ file, baseLines, currentLines });
  const sizes = [
    size('packages/ui/src/new-big.ts', null, 801),
    size('packages/ui/src/new-small.ts', null, 800),
    size('packages/ui/src/grew.tsx', 3000, 3001),
    size('packages/ui/src/crossed.tsx', 790, 810),
    size('packages/ui/src/shrank.tsx', 3000, 2500),
    size('packages/ui/src/same.tsx', 3000, 3000),
  ];
  assert.deepEqual(findOversizedGrowth(sizes).map(({ file }) => file), [
    'packages/ui/src/new-big.ts', 'packages/ui/src/grew.tsx', 'packages/ui/src/crossed.tsx',
  ]);
});

test('message catalogs, declarations, tests and files outside packages have no size limit', () => {
  const grown = (file) => ({ file, baseLines: 4000, currentLines: 4100 });
  assert.deepEqual(findOversizedGrowth([
    grown('packages/ui/src/lib/i18n/messages/en.ts'),
    grown('packages/ui/src/lib/i18n/messages/spaces.i18n.ts'),
    grown('packages/web/server/index.d.ts'),
    grown('packages/ui/src/sync/sync.test.ts'),
    grown('packages/ui/src/sync/__tests__/helpers.ts'),
    grown('scripts/anti-slop.mjs'),
  ]), []);
});
