import { describe, expect, test } from 'bun:test';
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { findMatchesInFileDiff, type DiffFindMatch } from './diffFind';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -2,3 +2,4 @@',
  ' line 2',
  '-old 3',
  '+new 3',
  '+new 4',
  ' line 4',
  '@@ -20,2 +21,2 @@',
  ' line 20',
  '-old 21',
  '+new 22',
  '',
].join('\n');

const patchDiff = (): FileDiffMetadata => {
  const fileDiff = parsePatchFiles(PATCH)[0]?.files[0];
  if (!fileDiff) throw new Error('patch did not parse');
  return fileDiff;
};

const fullDiff = (oldContents: string, newContents: string): FileDiffMetadata =>
  parseDiffFromFile({ name: 'a.ts', contents: oldContents }, { name: 'a.ts', contents: newContents });

const locations = (matches: DiffFindMatch[]): string[] =>
  matches.map((match) => `${match.side}:${match.lineNumber}@${match.spanStart}+${match.spanLength}`);

const inline = { layout: 'inline' } as const;
const split = { layout: 'side-by-side' } as const;

describe('findMatchesInFileDiff', () => {
  test('inline counts a context line once, on the additions side', () => {
    // " line 2" is additions:2, " line 4" is additions:5, " line 20" is additions:21.
    expect(locations(findMatchesInFileDiff(patchDiff(), 'a.ts', 'line', inline))).toEqual([
      'additions:2@0+4',
      'additions:5@0+4',
      'additions:21@0+4',
    ]);
  });

  test('side-by-side counts a context line on both sides with their own numbers', () => {
    expect(locations(findMatchesInFileDiff(patchDiff(), 'a.ts', 'line', split))).toEqual([
      'deletions:2@0+4',
      'additions:2@0+4',
      'deletions:4@0+4',
      'additions:5@0+4',
      'deletions:20@0+4',
      'additions:21@0+4',
    ]);
  });

  test('change-block lines keep their own side under either layout', () => {
    for (const layout of [inline, split]) {
      expect(locations(findMatchesInFileDiff(patchDiff(), 'a.ts', 'new', layout))).toEqual([
        'additions:3@0+3',
        'additions:4@0+3',
        'additions:22@0+3',
      ]);
      expect(locations(findMatchesInFileDiff(patchDiff(), 'a.ts', 'old', layout))).toEqual([
        'deletions:3@0+3',
        'deletions:21@0+3',
      ]);
    }
  });

  test('reports every occurrence within one line', () => {
    for (const layout of [inline, split]) {
      expect(locations(findMatchesInFileDiff(fullDiff('bb\n', 'aa aa\n'), 'a.ts', 'aa', layout))).toEqual([
        'additions:1@0+2',
        'additions:1@3+2',
      ]);
    }
  });

  test('is case-insensitive by default and honours caseSensitive', () => {
    expect(locations(findMatchesInFileDiff(patchDiff(), 'a.ts', 'NEW', split))).toEqual([
      'additions:3@0+3',
      'additions:4@0+3',
      'additions:22@0+3',
    ]);
    expect(findMatchesInFileDiff(patchDiff(), 'a.ts', 'NEW', { ...split, caseSensitive: true })).toEqual([]);
  });

  test('returns nothing for an empty query without trimming', () => {
    expect(findMatchesInFileDiff(patchDiff(), 'a.ts', '', inline)).toEqual([]);
    expect(findMatchesInFileDiff(patchDiff(), 'a.ts', '  ', inline)).toEqual([]);
  });

  test('returns nothing when the query is absent', () => {
    expect(findMatchesInFileDiff(patchDiff(), 'a.ts', 'zzz', inline)).toEqual([]);
  });

  test('maps unchanged trailing context per layout', () => {
    const diff = fullDiff('a\nb\nc\n', 'a\nB\nc\n');
    // "c" is the unchanged line 3; it is a context row in both layouts.
    expect(locations(findMatchesInFileDiff(diff, 'a.ts', 'c', inline))).toEqual(['additions:3@0+1']);
    expect(locations(findMatchesInFileDiff(diff, 'a.ts', 'c', split))).toEqual([
      'deletions:3@0+1',
      'additions:3@0+1',
    ]);
  });

  test('keeps the caller-provided file path on every match', () => {
    const matches = findMatchesInFileDiff(patchDiff(), 'src/deep/a.ts', 'new', inline);
    expect(matches.every((match) => match.filePath === 'src/deep/a.ts')).toBe(true);
  });
});
