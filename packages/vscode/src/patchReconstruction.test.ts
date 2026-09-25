import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructOriginalContentFromPatch } from './patchReconstruction';

const file = (...lines: string[]) => lines.join('\n');

describe('reconstructOriginalContentFromPatch', () => {
  test('restores indentation OpenCode trimmed from the diff', () => {
    const modified = file('class A {', '  run() {', '    return 2;', '  }', '}');
    // trimDiff removed the two spaces shared by every line.
    const patch = file('--- a.ts', '+++ a.ts', '@@ -2,3 +2,3 @@', ' run() {', '-  return 1;', '+  return 2;', ' }');
    assert.equal(
      reconstructOriginalContentFromPatch(modified, patch),
      file('class A {', '  run() {', '    return 1;', '  }', '}'),
    );
  });

  test('restores tab indentation across several hunks and keeps blank lines blank', () => {
    const modified = file('\tfunc a() {', '\t\tx := 2', '', '\t}', 'mid', '\tfunc b() {', '\t\ty := 3', '\t}');
    const patch = file(
      '@@ -1,4 +1,4 @@', ' func a() {', '-\tx := 1', '+\tx := 2', ' ', ' }',
      '@@ -6,3 +6,3 @@', ' func b() {', '-\ty := 1', '+\ty := 3', ' }',
    );
    assert.equal(
      reconstructOriginalContentFromPatch(modified, patch),
      file('\tfunc a() {', '\t\tx := 1', '', '\t}', 'mid', '\tfunc b() {', '\t\ty := 1', '\t}'),
    );
  });

  test('leaves untrimmed diffs unchanged', () => {
    const modified = file('a', '  b2', 'c');
    const patch = file('@@ -1,3 +1,3 @@', ' a', '-  b1', '+  b2', ' c');
    assert.equal(reconstructOriginalContentFromPatch(modified, patch), file('a', '  b1', 'c'));
  });

  test('falls back to pasting old lines when the file does not line up', () => {
    const modified = file('x', '  unrelated', 'z');
    const patch = file('@@ -1,2 +1,2 @@', '-old', '+new', ' other');
    assert.equal(reconstructOriginalContentFromPatch(modified, patch), file('old', 'other', 'z'));
  });

  test('returns null when the patch has no hunks', () => {
    assert.equal(reconstructOriginalContentFromPatch('a', 'not a diff'), null);
  });
});
