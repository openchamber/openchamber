import { describe, expect, it } from 'vitest';

import { resolveWindowSeconds, resolveWindowLabel } from './transformers.js';

describe('resolveWindowSeconds', () => {
  it('resolves the z.ai 5-hour token window (unit 3)', () => {
    expect(resolveWindowSeconds({ unit: 3, number: 5 })).toBe(18000);
  });

  it('resolves the z.ai weekly token window (unit 6)', () => {
    expect(resolveWindowSeconds({ unit: 6, number: 1 })).toBe(604800);
  });

  it('resolves day (unit 4) and month (unit 5) windows', () => {
    expect(resolveWindowSeconds({ unit: 4, number: 1 })).toBe(86400);
    expect(resolveWindowSeconds({ unit: 5, number: 1 })).toBe(2592000);
  });

  it('returns null for unknown units', () => {
    expect(resolveWindowSeconds({ unit: 99, number: 1 })).toBeNull();
  });

  it('returns null when number or limit is missing', () => {
    expect(resolveWindowSeconds({ unit: 3 })).toBeNull();
    expect(resolveWindowSeconds(null)).toBeNull();
  });
});

describe('resolveWindowLabel', () => {
  it('labels the 5-hour and weekly windows', () => {
    expect(resolveWindowLabel(18000)).toBe('5h');
    expect(resolveWindowLabel(604800)).toBe('weekly');
  });
});
