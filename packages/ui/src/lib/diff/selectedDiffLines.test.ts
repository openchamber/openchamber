import { describe, expect, test } from 'bun:test';
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { diffLineSource, getDiffLinesText } from './selectedDiffLines';

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

describe('getDiffLinesText', () => {
  test('reads file line numbers from a patch that starts mid-file', () => {
    const fileDiff = patchDiff();
    expect(fileDiff.isPartial).toBe(true);

    expect(getDiffLinesText(fileDiff, 'additions', 3, 4)).toBe('new 3\nnew 4');
    expect(getDiffLinesText(fileDiff, 'additions', 22, 22)).toBe('new 22');
    expect(getDiffLinesText(fileDiff, 'deletions', 21, 21)).toBe('old 21');
  });

  test('skips lines the patch does not contain', () => {
    expect(getDiffLinesText(patchDiff(), 'additions', 5, 21)).toBe('line 4\nline 20');
  });

  test('reads a diff built from full contents by line number', () => {
    const fileDiff = parseDiffFromFile(
      { name: 'a.ts', contents: 'a\nb\nc\n' },
      { name: 'a.ts', contents: 'a\nB\nc\n' },
    );

    expect(getDiffLinesText(fileDiff, 'additions', 1, 2)).toBe('a\nB');
    expect(getDiffLinesText(fileDiff, 'deletions', 2, 3)).toBe('b\nc');
  });
});

describe('diffLineSource', () => {
  test('a patch holds its hunk lines only and says so', () => {
    const source = diffLineSource(patchDiff(), 'additions');
    expect(source.partial).toBe(true);
    expect([source.first, source.last]).toEqual([2, 22]);
    expect(source.lineAt(4)).toBe('new 4');
    expect(source.lineAt(10)).toBeUndefined();
    expect(diffLineSource(patchDiff(), 'deletions').lineAt(21)).toBe('old 21');
  });

  test('a diff built from full contents holds the whole file', () => {
    const fileDiff = parseDiffFromFile({ name: 'a.ts', contents: 'a\nb\nc' }, { name: 'a.ts', contents: 'a\nB\nc' });
    const source = diffLineSource(fileDiff, 'additions');
    expect(source.partial).toBeFalsy();
    expect([source.first, source.last, source.lineAt(2)]).toEqual([1, 3, 'B']);
  });
});
