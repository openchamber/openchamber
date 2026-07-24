import { describe, expect, it } from 'vitest';

import { buildZaiWindows } from './zai.js';

const LIVE_LIMITS = [
  { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, remaining: 4000, percentage: 0, nextResetTime: 1784338722981 },
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
  { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 77, nextResetTime: 1784165922979 }
];

describe('buildZaiWindows', () => {
  it('emits both the 5h and weekly token windows', () => {
    const windows = buildZaiWindows(LIVE_LIMITS);
    expect(Object.keys(windows).sort()).toEqual(['5h', 'weekly']);
  });

  it('maps the weekly window usage and reset', () => {
    const windows = buildZaiWindows(LIVE_LIMITS);
    expect(windows.weekly.usedPercent).toBe(77);
    expect(windows.weekly.resetAt).toBe(1784165922979);
    expect(windows.weekly.windowSeconds).toBe(604800);
  });

  it('tolerates a 5h window with no reset time when idle', () => {
    const windows = buildZaiWindows(LIVE_LIMITS);
    expect(windows['5h'].usedPercent).toBe(0);
    expect(windows['5h'].resetAt).toBeNull();
    expect(windows['5h'].windowSeconds).toBe(18000);
  });

  it('ignores TIME_LIMIT and unknown-unit entries', () => {
    const windows = buildZaiWindows([
      ...LIVE_LIMITS,
      { type: 'TOKENS_LIMIT', unit: 99, number: 1, percentage: 10 }
    ]);
    expect(Object.keys(windows).sort()).toEqual(['5h', 'weekly']);
  });

  it('returns an empty object for missing or non-array limits', () => {
    expect(buildZaiWindows(undefined)).toEqual({});
    expect(buildZaiWindows(null)).toEqual({});
  });
});
