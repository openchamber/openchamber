import { describe, test, expect } from 'bun:test';
import { buildSearchRegex, splitByHighlight } from './splitByHighlight';
import type { SearchFlags } from '@/stores/useChatSearchStore';

const plain: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false };
const cs: SearchFlags = { caseSensitive: true, wholeWord: false, regex: false };
const ww: SearchFlags = { caseSensitive: false, wholeWord: true, regex: false };
const rx: SearchFlags = { caseSensitive: false, wholeWord: false, regex: true };

describe('buildSearchRegex', () => {
  test('returns null for empty query', () => {
    expect(buildSearchRegex('', plain)).toBeNull();
  });

  test('returns a case-insensitive regex by default', () => {
    const re = buildSearchRegex('foo', plain);
    expect(re).not.toBeNull();
    expect(re!.flags).toContain('i');
  });

  test('returns a case-sensitive regex when flag is set', () => {
    const re = buildSearchRegex('foo', cs);
    expect(re!.flags).not.toContain('i');
  });

  test('adds word boundaries for whole-word flag', () => {
    const re = buildSearchRegex('foo', ww);
    expect(re!.source).toContain('\\b');
  });

  test('treats query as literal when regex flag is off', () => {
    const re = buildSearchRegex('f.o', plain);
    // dot should be escaped
    expect(re!.source).toBe('f\\.o');
  });

  test('treats query as regex pattern when flag is on', () => {
    const re = buildSearchRegex('f.o', rx);
    // dot should NOT be escaped
    expect(re!.source).toBe('f.o');
  });

  test('returns null for invalid regex', () => {
    expect(buildSearchRegex('[unclosed', rx)).toBeNull();
  });

  test('returns null for patterns over the length limit', () => {
    const longPattern = 'a'.repeat(501);
    expect(buildSearchRegex(longPattern, rx)).toBeNull();
  });

  test('returns null for nested-quantifier ReDoS patterns', () => {
    // (a+)+ is a classic catastrophic backtracking pattern
    expect(buildSearchRegex('(a+)+', rx)).toBeNull();
    expect(buildSearchRegex('(.+)*', rx)).toBeNull();
  });

  test('allows safe regex patterns', () => {
    expect(buildSearchRegex('[a-z]+', rx)).not.toBeNull();
    expect(buildSearchRegex('\\d{3}', rx)).not.toBeNull();
  });

  test('returns null for zero-length-only patterns like ^', () => {
    // A bare ^ produces a zero-length match at position 0
    expect(buildSearchRegex('^', rx)).toBeNull();
  });
});

describe('splitByHighlight zero-length safety', () => {
  test('does not create empty isMatch segments for patterns that could produce zero-length matches', () => {
    // Use a raw RegExp since buildSearchRegex would reject pure zero-length patterns
    const re = /x*/g;
    const result = splitByHighlight('abc', re);
    // Only non-empty segments should appear (the zero-length matches should be skipped)
    expect(result.every((s) => s.text.length > 0)).toBe(true);
  });
});

describe('splitByHighlight', () => {
  test('returns a single non-match segment when nothing matches', () => {
    const re = buildSearchRegex('xyz', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello world', isMatch: false },
    ]);
  });

  test('splits a single match in the middle', () => {
    const re = buildSearchRegex('world', plain)!;
    expect(splitByHighlight('hello world!', re)).toEqual([
      { text: 'hello ', isMatch: false },
      { text: 'world', isMatch: true },
      { text: '!', isMatch: false },
    ]);
  });

  test('handles a match at the start', () => {
    const re = buildSearchRegex('hello', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello', isMatch: true },
      { text: ' world', isMatch: false },
    ]);
  });

  test('handles a match at the end', () => {
    const re = buildSearchRegex('world', plain)!;
    expect(splitByHighlight('hello world', re)).toEqual([
      { text: 'hello ', isMatch: false },
      { text: 'world', isMatch: true },
    ]);
  });

  test('handles multiple matches', () => {
    const re = buildSearchRegex('o', plain)!;
    expect(splitByHighlight('foo', re)).toEqual([
      { text: 'f', isMatch: false },
      { text: 'o', isMatch: true },
      { text: 'o', isMatch: true },
    ]);
  });

  test('handles case-insensitive matching', () => {
    const re = buildSearchRegex('HELLO', plain)!;
    const result = splitByHighlight('hello world', re);
    expect(result[0]).toEqual({ text: 'hello', isMatch: true });
  });

  test('returns single non-match for empty text', () => {
    const re = buildSearchRegex('foo', plain)!;
    expect(splitByHighlight('', re)).toEqual([]);
  });

  test('whole word flag does not match partial words', () => {
    const re = buildSearchRegex('arg', ww)!;
    const result = splitByHighlight('argument parser', re);
    // 'arg' inside 'argument' should NOT match whole-word
    expect(result.every((p) => !p.isMatch)).toBe(true);
  });
});
