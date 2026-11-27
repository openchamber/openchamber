import { describe, expect, test } from 'bun:test';

import { isWholeFileReviewThread } from '../wholeFileComment';

describe('which review threads belong on the whole-file card', () => {
  test('a thread written on the file does, also after a push (the host does not mark it outdated)', () => {
    expect(isWholeFileReviewThread({ line: null })).toBe(true);
    expect(isWholeFileReviewThread({ line: null, outdated: false })).toBe(true);
  });

  test('an outdated line thread, which also comes without a line, does not', () => {
    expect(isWholeFileReviewThread({ line: null, outdated: true })).toBe(false);
  });

  test('a thread on a line does not', () => {
    expect(isWholeFileReviewThread({ line: 4 })).toBe(false);
  });
});
