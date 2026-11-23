import { describe, expect, test } from 'bun:test';

import type { UsageWindow } from '@/types';
import { usageValueTone } from './usageValueTone';

const usageWindow = (usedPercent: number | null): UsageWindow => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

describe('usage value colour', () => {
  test('only a limit running low takes a colour: muted while healthy, warning from 50% used, critical from 80%', () => {
    expect(usageValueTone(usageWindow(12))).toBe('muted');
    expect(usageValueTone(usageWindow(49))).toBe('muted');
    expect(usageValueTone(usageWindow(50))).toBe('warning');
    expect(usageValueTone(usageWindow(79))).toBe('warning');
    expect(usageValueTone(usageWindow(80))).toBe('error');
  });

  test('a count that is not a limit stays muted', () => {
    expect(usageValueTone(usageWindow(null))).toBe('muted');
  });
});
