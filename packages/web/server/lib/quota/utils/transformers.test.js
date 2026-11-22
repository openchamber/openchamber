import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, toTimestamp, asObject, resolveWindowLabel, resolveWindowSeconds, toNumber } from './transformers.js';


describe('toTimestamp', () => {
  it('returns null for non-finite numeric inputs', () => {
    expect(toTimestamp(NaN)).toBeNull();
    expect(toTimestamp(Infinity)).toBeNull();
    expect(toTimestamp(-Infinity)).toBeNull();
  });

  it('scales finite seconds to milliseconds below 1e12', () => {
    expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('passes finite millisecond values through unchanged', () => {
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('parses valid date strings and rejects unparseable ones', () => {
    expect(toTimestamp('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000);
    expect(toTimestamp('garbage')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(toTimestamp(null)).toBeNull();
    expect(toTimestamp(undefined)).toBeNull();
  });
});

describe('normalizeTimestamp', () => {
  it('returns null for non-finite numeric inputs', () => {
    expect(normalizeTimestamp(NaN)).toBeNull();
    expect(normalizeTimestamp(Infinity)).toBeNull();
    expect(normalizeTimestamp(-Infinity)).toBeNull();
  });

  it('scales finite seconds to milliseconds below 1e12', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('passes finite millisecond values through unchanged', () => {
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('returns null for non-numeric inputs', () => {
    expect(normalizeTimestamp('2023-11-14T22:13:20.000Z')).toBeNull();
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(undefined)).toBeNull();
  });
});

// ---- upstream tests ----

describe('quota boundary conversions', () => {
  it('keeps arrays and objects without copying and rejects primitives', () => {
    for (const value of [{}, [], { nested: [] }, new Date(0), Object.create(null), Promise.resolve(1), { then: () => {} }]) {
      expect(asObject(value)).toBe(value);
    }
    for (const value of [undefined, null, false, true, 0, 1, '', 'value', 1n, Symbol('external'), () => {}]) {
      expect(asObject(value)).toBeNull();
    }
  });

  it('accepts finite numbers and numeric strings, including blank strings', () => {
    for (const [value, expected] of [[0, 0], [-1, -1], [' 1.5 ', 1.5], ['', 0], [' ', 0]]) {
      expect(toNumber(value)).toBe(expected);
    }
    for (const value of [undefined, null, true, {}, [], NaN, Infinity, 'invalid', 'Infinity', 1n, Symbol('external'), new Date(0)]) {
      expect(toNumber(value)).toBeNull();
    }
  });

  it('preserves the distinct timestamp acceptance rules', () => {
    expect(toTimestamp(0)).toBeNull();
    expect(normalizeTimestamp(0)).toBe(0);
    expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTimestamp('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(normalizeTimestamp('2026-01-01T00:00:00Z')).toBeNull();
    expect(toTimestamp(NaN)).toBeNull();
    expect(normalizeTimestamp(NaN)).toBeNull();
    expect(toTimestamp(Infinity)).toBeNull();
    expect(normalizeTimestamp(Infinity)).toBeNull();
    for (const value of [undefined, null, false, {}, [], 'invalid', 1n, Symbol('external'), new Date(0)]) {
      expect(toTimestamp(value)).toBeNull();
      expect(normalizeTimestamp(value)).toBeNull();
    }
  });

  it('keeps sparse unit lookup and duration labels', () => {
    expect(resolveWindowSeconds({ unit: 3, number: 5 })).toBe(18_000);
    expect(resolveWindowSeconds({ unit: 6, number: 1 })).toBe(604_800);
    expect(resolveWindowSeconds({ unit: '3', number: 5 })).toBe(18_000);
    for (const value of [undefined, null, {}, { unit: 3 }, { unit: 3, number: 0 }, { unit: 4, number: 1 }]) {
      expect(resolveWindowSeconds(value)).toBeNull();
    }
    expect(resolveWindowLabel(null)).toBe('tokens');
    expect(resolveWindowLabel(0)).toBe('tokens');
    expect(resolveWindowLabel(604_800)).toBe('weekly');
    expect(resolveWindowLabel(172_800)).toBe('2d');
    expect(resolveWindowLabel(18_000)).toBe('5h');
    expect(resolveWindowLabel(90)).toBe('90s');
  });
});
