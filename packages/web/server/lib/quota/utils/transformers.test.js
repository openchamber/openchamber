import { describe, expect, it } from 'vitest';

import { normalizeTimestamp, toTimestamp } from './transformers.js';

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
