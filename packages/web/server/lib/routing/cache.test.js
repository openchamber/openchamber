import { describe, expect, it } from 'vitest';
import { PROMPT_CACHE_TTL_MS, warmWindowMs } from './cache.js';

describe('routing warm window', () => {
  it('accepts entries without info and keeps the last warming value', () => {
    expect(warmWindowMs([{ path: '/repo' }])).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: true } }, { path: '/repo' }]))
      .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
  });

  it('treats a malformed response as a cold cache', () => {
    expect(warmWindowMs([{ info: { warming: true } }, { info: { warming: 'yes' } }]))
      .toBe(PROMPT_CACHE_TTL_MS);
  });

  it('ignores absent warming fields after the last explicit value', () => {
    expect(warmWindowMs([{ info: { warming: true } }, { info: null }, {}]))
      .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
  });

  it('keeps the default duration for inherited dictionary names and unknown units', () => {
    for (const duration of ['1 constructor', '1 toString', '1 unknown']) {
      expect(warmWindowMs([{ info: { warming: { duration } } }]))
        .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
    }
  });

  it('parses each supported duration scale', () => {
    for (const [duration, ms] of [['1 millis', 1], ['2 seconds', 2000], ['1.5 minutes', 90_000], ['2 hours', 7_200_000]]) {
      expect(warmWindowMs([{ info: { warming: { duration } } }])).toBe(ms + PROMPT_CACHE_TTL_MS);
    }
  });
});
