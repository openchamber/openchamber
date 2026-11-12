import { describe, expect, test } from 'bun:test';

import { findWordAtOffset } from './findWord';

// `findWordAtOffset` is the pure half of primary-modifier word lookup: given a
// row's text (the same offset space `wrapRowSpan` and DiffFindMatch.spanStart
// use) and a caret offset inside it, it returns the expanded word. The caret
// API half (shadow root, caretPositionFromPoint) has no happy-dom equivalent
// and is exercised only by the real-browser harness.

describe('findWordAtOffset', () => {
  test('expands from the middle of a word', () => {
    expect(findWordAtOffset('foo bar', 1)).toEqual({ word: 'foo', spanStart: 0 });
    expect(findWordAtOffset('foo bar', 5)).toEqual({ word: 'bar', spanStart: 4 });
  });

  test('expands from a word start', () => {
    expect(findWordAtOffset('foo bar', 0)).toEqual({ word: 'foo', spanStart: 0 });
    expect(findWordAtOffset('foo bar', 4)).toEqual({ word: 'bar', spanStart: 4 });
  });

  test('expands from a word end', () => {
    expect(findWordAtOffset('foo bar', 2)).toEqual({ word: 'foo', spanStart: 0 });
    expect(findWordAtOffset('foo bar', 6)).toEqual({ word: 'bar', spanStart: 4 });
  });

  test('a caret past the last character belongs to the last word', () => {
    expect(findWordAtOffset('foo bar', 7)).toEqual({ word: 'bar', spanStart: 4 });
    expect(findWordAtOffset('foo', 3)).toEqual({ word: 'foo', spanStart: 0 });
  });

  test('returns null on whitespace and punctuation', () => {
    expect(findWordAtOffset('foo   bar', 4)).toBeNull();
    expect(findWordAtOffset('foo bar', 3)).toBeNull();
    expect(findWordAtOffset('a.b', 1)).toBeNull();
    expect(findWordAtOffset('  lead', 0)).toBeNull();
    expect(findWordAtOffset('trail  ', 6)).toBeNull();
  });

  test('treats $, _ and digits as word characters', () => {
    expect(findWordAtOffset('foo_bar$1 baz', 3)).toEqual({ word: 'foo_bar$1', spanStart: 0 });
    expect(findWordAtOffset('foo_bar$1 baz', 8)).toEqual({ word: 'foo_bar$1', spanStart: 0 });
    expect(findWordAtOffset('foo_bar$1 baz', 10)).toEqual({ word: 'baz', spanStart: 10 });
  });

  test('treats CJK letters as word characters', () => {
    expect(findWordAtOffset('你好 世界', 1)).toEqual({ word: '你好', spanStart: 0 });
    expect(findWordAtOffset('你好 世界', 3)).toEqual({ word: '世界', spanStart: 3 });
    expect(findWordAtOffset('你好世界', 2)).toEqual({ word: '你好世界', spanStart: 0 });
  });

  test('keeps a tab indent out of the word but in the offset', () => {
    expect(findWordAtOffset('\tfoo', 1)).toEqual({ word: 'foo', spanStart: 1 });
    expect(findWordAtOffset('\t\tbar baz', 2)).toEqual({ word: 'bar', spanStart: 2 });
  });

  test('returns null for an empty line or an out-of-range offset', () => {
    expect(findWordAtOffset('', 0)).toBeNull();
    expect(findWordAtOffset('foo', -1)).toBeNull();
    expect(findWordAtOffset('foo', 4)).toBeNull();
  });
});
