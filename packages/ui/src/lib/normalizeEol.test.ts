import { describe, expect, test } from 'bun:test';

import { eolEqual, normalizeEol, prepareForDiff, splitLines } from './normalizeEol';

describe('normalizeEol', () => {
  test('normalizes CRLF and CR to LF', () => {
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
  });

  test('compares content ignoring line ending differences', () => {
    expect(eolEqual('a\r\nb\r\n', 'a\nb\n')).toBe(true);
  });

  test('splits normalized lines', () => {
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
  });

  test('prepares non-binary diff payloads', () => {
    expect(prepareForDiff({ original: 'a\r\n', modified: 'b\r\n' })).toEqual({ original: 'a\n', modified: 'b\n' });
  });

  test('leaves binary diff payloads unchanged', () => {
    const diff = { original: 'data:abc', modified: 'data:def', isBinary: true };
    expect(prepareForDiff(diff)).toBe(diff);
  });
});
