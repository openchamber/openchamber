import { describe, expect, test } from 'bun:test';

import { contentFingerprint, estimateTokenRunsBytes, HighlightResultCache, utf16Bytes } from './highlightResultCache';

describe('HighlightResultCache', () => {
  test('returns cached values for identical keys and refreshes LRU order', () => {
    const cache = new HighlightResultCache<string>({ maxEntries: 2, maxBytes: 10_000 });
    cache.set('a', 'one', utf16Bytes('a') + utf16Bytes('one'));
    cache.set('b', 'two', utf16Bytes('b') + utf16Bytes('two'));
    expect(cache.get('a')).toBe('one');
    cache.set('c', 'three', utf16Bytes('c') + utf16Bytes('three'));
    expect(cache.get('b')).toEqual(undefined);
    expect(cache.get('a')).toBe('one');
    expect(cache.get('c')).toBe('three');
  });

  test('evicts by byte budget while still caching a single oversized entry', () => {
    const cache = new HighlightResultCache<string>({ maxEntries: 10, maxBytes: 64 });
    cache.set('small', 'x', utf16Bytes('small') + utf16Bytes('x'));
    cache.set('huge', 'y'.repeat(200), utf16Bytes('huge') + utf16Bytes('y'.repeat(200)));
    expect(cache.get('huge')).toBe('y'.repeat(200));
    expect(cache.size).toBe(1);
  });

  test('contentFingerprint is stable and length-qualified', () => {
    expect(contentFingerprint('const x = 1')).toBe(contentFingerprint('const x = 1'));
    expect(contentFingerprint('const x = 1')).not.toBe(contentFingerprint('const x = 2'));
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('abc'));
  });

  test('contentFingerprint stays collision-free across a realistic session', () => {
    // A collision returns another source's HTML, so exercise same-length,
    // near-identical tool output at a session-sized working set.
    const seen = new Map<string, string>();
    for (let i = 0; i < 20_000; i += 1) {
      const source = `const value_${String(i).padStart(6, '0')} = ${String(i).padStart(6, '0')};`;
      const fingerprint = contentFingerprint(source);
      expect(seen.get(fingerprint) ?? source).toBe(source);
      seen.set(fingerprint, source);
    }
    expect(seen.size).toBe(20_000);
  });

  test('estimateTokenRunsBytes avoids JSON and stays positive', () => {
    const lines: Array<Array<[number, string, number]>> = [
      [[3, '#fff', 0], [1, '', 1]],
      [[8, 'var(--md-syntax-keyword)', 0]],
    ];
    expect(estimateTokenRunsBytes(lines)).toBeGreaterThan(0);
  });
});
