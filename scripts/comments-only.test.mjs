import assert from 'node:assert/strict';
import { test } from 'node:test';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'comments-only.mjs');

const same = (file, before, after) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oc-comments-only-'));
  const extension = path.extname(file);
  const paths = [['before', before], ['after', after]].map(([name, text]) => {
    const target = path.join(directory, `${name}${extension}`);
    writeFileSync(target, text);
    return target;
  });
  return spawnSync('bun', [SCRIPT, '--files', ...paths]).status === 0;
};

test('removing comments of every kind leaves the code the same', () => {
  const before = [
    '/** Adds. */',
    'export const add = (a: number, b: number) => {',
    '  // sum them',
    '  return a + b; /* done */',
    '};',
  ].join('\n');
  assert.equal(same('a.ts', before, 'export const add = (a: number, b: number) => {\n  return a + b;\n};\n'), true);
});

test('a JSX comment and its braces go together', () => {
  const before = 'export const A = () => (\n  <div>\n    {/* title */}\n    <b>Hi there</b>\n  </div>\n);\n';
  const after = 'export const A = () => (\n  <div>\n    <b>Hi there</b>\n  </div>\n);\n';
  assert.equal(same('a.tsx', before, after), true);
});

test('a changed value, a dropped statement or changed JSX text is a code change', () => {
  assert.equal(same('a.ts', 'const a = 1; // one\n', 'const a = 2;\n'), false);
  assert.equal(same('a.ts', 'run(); // go\nstop();\n', 'run();\n'), false);
  assert.equal(same('a.tsx', 'const A = <b>Hi there</b>;\n', 'const A = <b>Hi</b>;\n'), false);
  assert.equal(same('a.ts', "const url = 'http://x'; // note\n", "const url = 'http:';\n"), false);
});

test('a comment-like string or a directive string is code', () => {
  assert.equal(same('a.ts', "const s = '// not a comment';\n", "const s = '';\n"), false);
});
