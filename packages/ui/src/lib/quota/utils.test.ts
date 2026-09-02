import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, formatWindowLabel } from './utils';

describe('quota utils', () => {
  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });

  test('labels Copilot usage as AI Credits without changing generic premium usage', () => {
    expect(formatWindowLabel('premium')).toBe('Premium Interactions');
    expect(formatWindowLabel('premium_interactions')).toBe('AI Credits');
  });
});
