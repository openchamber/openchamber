import { describe, expect, it } from 'vitest';
import { pairedDiffLine, reviewCommentPosition } from './review-position.js';

const fail = (message) => { throw new Error(message); };

describe('reviewCommentPosition', () => {
  it('keeps lines of one side, or a whole file without lines', () => {
    expect(reviewCommentPosition({ path: 'a', side: 'new', line: 3 }, fail)).toEqual({ path: 'a', side: 'new', line: 3 });
    expect(reviewCommentPosition({ path: 'a', side: 'old', startLine: 1, line: 3 }, fail)).toEqual({ path: 'a', side: 'old', startLine: 1, line: 3 });
    expect(reviewCommentPosition({ path: 'a' }, fail)).toEqual({ path: 'a' });
  });

  it.each([
    [{ path: '', side: 'new', line: 1 }],
    [{ path: 'a', side: 'both', line: 1 }],
    [{ path: 'a', side: 'new', line: 0 }],
    [{ path: 'a', side: 'new', startLine: 4, line: 3 }],
    [{ path: 'a', side: 'new' }],
    [{ path: 'a', startLine: 2 }],
  ])('refuses %j', (body) => {
    expect(() => reviewCommentPosition(body, fail)).toThrow();
  });
});

describe('pairedDiffLine', () => {
  const patch = '@@ -10,3 +10,3 @@ fn\n ctx\n-old\n+new\n ctx2\n\\ No newline at end of file\n@@ -40 +40,2 @@\n end\n+tail\n';

  it('names both sides of an unchanged line and one side of a changed one', () => {
    expect(pairedDiffLine(patch, 'new', 10)).toEqual({ oldLine: 10, newLine: 10 });
    expect(pairedDiffLine(patch, 'old', 12)).toEqual({ oldLine: 12, newLine: 12 });
    expect(pairedDiffLine(patch, 'new', 11)).toEqual({ oldLine: null, newLine: 11 });
    expect(pairedDiffLine(patch, 'old', 11)).toEqual({ oldLine: 11, newLine: null });
    expect(pairedDiffLine(patch, 'new', 41)).toEqual({ oldLine: null, newLine: 41 });
  });

  it('answers null for a line outside the hunks', () => {
    expect(pairedDiffLine(patch, 'new', 20)).toBeNull();
    expect(pairedDiffLine('', 'new', 1)).toBeNull();
  });
});
