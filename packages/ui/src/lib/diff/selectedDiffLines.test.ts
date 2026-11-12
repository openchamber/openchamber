import { describe, expect, test } from 'bun:test';
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { getDiffLinesText } from './selectedDiffLines';

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
