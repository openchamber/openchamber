import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSidesFromFullPatch, isFileDeletionPatch, reconstructOriginalContentFromPatch } from './patchReconstruction';

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

  test('rebuilds a deleted file from an empty one', () => {
    const patch = file('--- a.txt', '+++ a.txt', '@@ -1,2 +0,0 @@', '-first', '-second', '');
    assert.equal(reconstructOriginalContentFromPatch('', patch), file('first', 'second', ''));
  });

  test('tells a deletion from an edit', () => {
    assert.equal(isFileDeletionPatch(file('--- a.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-first', '-second')), true);
    assert.equal(isFileDeletionPatch(file('@@ -1,2 +1,1 @@', '-first', ' second')), false);
    assert.equal(isFileDeletionPatch('not a diff'), false);
  });

  test('returns null when the patch has no hunks', () => {
    assert.equal(reconstructOriginalContentFromPatch('a', 'not a diff'), null);
  });
});

describe('fileSidesFromFullPatch', () => {
  test('reads both sides of the file from a full-context patch, whatever the file holds now', () => {
    const patch = file('--- a.sql', '+++ a.sql', '@@ -1,3 +1,3 @@', ' select 1;', '--- old note', '+-- new note', ' end;', '');
    assert.deepEqual(fileSidesFromFullPatch(patch), {
      original: file('select 1;', '-- old note', 'end;', ''),
      modified: file('select 1;', '-- new note', 'end;', ''),
    });
  });

  test('keeps a missing final newline on the side that lacks it', () => {
    const patch = file('@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', '');
    assert.deepEqual(fileSidesFromFullPatch(patch), { original: file('a', 'b'), modified: file('a', 'b', '') });
  });

  test('gives an empty side for an added or a deleted file', () => {
    assert.deepEqual(fileSidesFromFullPatch(file('@@ -0,0 +1,1 @@', '+new', '')), { original: '', modified: file('new', '') });
    assert.deepEqual(fileSidesFromFullPatch(file('@@ -1,1 +0,0 @@', '-gone', '')), { original: file('gone', ''), modified: '' });
  });

  test('keeps carriage returns, so a line-ending change still shows two sides', () => {
    // `git diff` output for a file converted from CRLF to LF with core.autocrlf off.
    const patch = 'diff --git a/f.txt b/f.txt\nindex c30dea8..422c2b7 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-a\r\n-b\r\n+a\n+b\n';
    assert.deepEqual(fileSidesFromFullPatch(patch), { original: 'a\r\nb\r\n', modified: 'a\nb\n' });
  });

  test('refuses a patch that does not cover the whole file', () => {
    assert.equal(fileSidesFromFullPatch(file('@@ -4,2 +4,2 @@', '-x', '+y', ' z')), null);
    assert.equal(fileSidesFromFullPatch(file('@@ -1,1 +1,1 @@', '-a', '+b', '@@ -9,1 +9,1 @@', '-c', '+d')), null);
    assert.equal(fileSidesFromFullPatch('not a diff'), null);
  });
});
