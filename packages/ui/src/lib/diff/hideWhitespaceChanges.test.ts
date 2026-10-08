import { describe, expect, test } from 'bun:test';
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { hideWhitespaceChanges } from './hideWhitespaceChanges';

const diffOf = (before: string, after: string): FileDiffMetadata =>
  parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after });

const stripWhitespace = (text: string): string => text.split('\n').map((line) => line.replace(/\s+/g, '')).join('\n');

const layout = (fileDiff: FileDiffMetadata) => ({
  splitLineCount: fileDiff.splitLineCount,
  unifiedLineCount: fileDiff.unifiedLineCount,
  hunks: fileDiff.hunks.map((hunk) => ({
    collapsedBefore: hunk.collapsedBefore,
    additionStart: hunk.additionStart,
    additionCount: hunk.additionCount,
    additionLines: hunk.additionLines,
    deletionStart: hunk.deletionStart,
    deletionCount: hunk.deletionCount,
    deletionLines: hunk.deletionLines,
    splitLineStart: hunk.splitLineStart,
    splitLineCount: hunk.splitLineCount,
    unifiedLineStart: hunk.unifiedLineStart,
    unifiedLineCount: hunk.unifiedLineCount,
  })),
});

const lines = (count: number, indent: string, label = 'line') =>
  Array.from({ length: count }, (_, index) => `${indent}${label}${index + 1};`);

describe('hideWhitespaceChanges', () => {
  test('removing a wrapping if leaves only the if and its brace', () => {
    const body = lines(12, '');
    const before = ['function run() {', '  if (ready) {', ...body.map((line) => `    ${line}`), '  }', '  done();', '}', ''].join('\n');
    const after = ['function run() {', ...body.map((line) => `  ${line}`), '  done();', '}', ''].join('\n');

    const visible = hideWhitespaceChanges(diffOf(before, after));

    expect(visible.hunks.map((hunk) => [hunk.hunkSpecs, hunk.collapsedBefore])).toEqual([
      ['@@ -1,5 +1,4 @@\n', 0],
      ['@@ -12,6 +11,5 @@\n', 6],
    ]);
    expect([visible.splitLineCount, visible.unifiedLineCount]).toEqual([17, 17]);
    const [opening, closing] = visible.hunks;
    expect(opening?.hunkContent.filter((block) => block.type === 'change')).toEqual([
      { type: 'change', deletions: 1, deletionLineIndex: 1, additions: 0, additionLineIndex: 1 },
    ]);
    expect(closing?.deletionLines).toBe(1);
    expect(closing?.additionLines).toBe(0);
    // Context rows keep each side's own text.
    const context = opening?.hunkContent.find((block) => block.type === 'context' && block.deletionLineIndex === 2);
    expect(context?.type).toBe('context');
    expect(visible.deletionLines[2]).toBe('    line1;\n');
    expect(visible.additionLines[1]).toBe('  line1;\n');
  });

  test('a real edit inside re-indented code stays a change', () => {
    const before = ['{', ...lines(3, '  '), '}', ''].join('\n');
    const after = ['{', '    line1;', '    changed;', '    line3;', '}', ''].join('\n');

    const visible = hideWhitespaceChanges(diffOf(before, after));

    expect(visible.hunks).toHaveLength(1);
    expect(visible.hunks[0]?.hunkContent.filter((block) => block.type === 'change')).toEqual([
      { type: 'change', deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 2 },
    ]);
    expect(layout(visible)).toEqual(layout(diffOf(stripWhitespace(before), stripWhitespace(after))));
  });

  test('a file that only changed whitespace has no hunks left', () => {
    const before = ['a', 'b', 'c', ''].join('\n');
    const after = ['a  ', '\tb', 'c\r', ''].join('\n');

    expect(hideWhitespaceChanges(diffOf(before, after)).hunks).toEqual([]);
  });

  test('a diff without whitespace-only lines is returned as is', () => {
    const fileDiff = diffOf('a\nb\n', 'a\nc\n');

    expect(hideWhitespaceChanges(fileDiff)).toBe(fileDiff);
  });

  test('works on patch-only diffs without reaching past their hunks', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,9 +10,9 @@ class A {',
      ' one',
      ' two',
      ' three',
      '-  four',
      '-  five',
      '+    four',
      '+    five',
      ' six',
      '-seven',
      '+SEVEN',
      ' eight',
      ' nine',
      '',
    ].join('\n');
    const fileDiff = parsePatchFiles(patch)[0]?.files[0];
    if (!fileDiff) throw new Error('patch did not parse');

    const visible = hideWhitespaceChanges(fileDiff);

    expect(visible.isPartial).toBe(true);
    expect(layout(visible).hunks).toEqual([{
      collapsedBefore: 12,
      additionStart: 13,
      additionCount: 6,
      additionLines: 1,
      deletionStart: 13,
      deletionCount: 6,
      deletionLines: 1,
      splitLineStart: 12,
      splitLineCount: 6,
      unifiedLineStart: 12,
      unifiedLineCount: 7,
    }]);
    expect(visible.hunks[0]?.hunkContext).toBeUndefined();
    expect(visible.hunks[0]?.hunkSpecs).toBe('@@ -13,6 +13,6 @@\n');
  });

  test('a change next to a re-indented line keeps its usual context', () => {
    const before = ['a', 'b', '  c', 'd', ''].join('\n');
    const after = ['A', 'b', 'c', 'd', ''].join('\n');

    const visible = hideWhitespaceChanges(diffOf(before, after));

    expect(visible.hunks).toHaveLength(1);
    expect(layout(visible)).toEqual(layout(diffOf(stripWhitespace(before), stripWhitespace(after))));
  });
});
