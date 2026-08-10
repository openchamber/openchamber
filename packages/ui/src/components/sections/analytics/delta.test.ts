import { describe, expect, test } from 'bun:test';
import { deltaKind, deltaPercent, formatDeltaPercent } from './delta';

describe('deltaKind', () => {
  test('new when no previous period', () => {
    expect(deltaKind(10, 0)).toBe('new');
  });
  test('flat / up / down', () => {
    expect(deltaKind(10, 10)).toBe('flat');
    expect(deltaKind(12, 10)).toBe('up');
    expect(deltaKind(8, 10)).toBe('down');
  });
});

describe('deltaPercent', () => {
  test('rounded absolute percent', () => {
    expect(deltaPercent(13, 10)).toBe(30);
    expect(deltaPercent(7, 10)).toBe(30);
  });
  test('zero when prev is zero', () => {
    expect(deltaPercent(5, 0)).toBe(0);
  });
});

describe('formatDeltaPercent', () => {
  test('passes through moderate percentages', () => {
    expect(formatDeltaPercent(0)).toBe('0');
    expect(formatDeltaPercent(30)).toBe('30');
    expect(formatDeltaPercent(999)).toBe('999');
  });
  test('caps explosive percentages from tiny baselines', () => {
    expect(formatDeltaPercent(14100)).toBe('999+');
    expect(formatDeltaPercent(1000)).toBe('999+');
  });
});
