import { describe, expect, test } from 'bun:test';

import { formatRelativeMessageTime } from './timeFormat';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('formatRelativeMessageTime', () => {
  const now = Date.UTC(2026, 5, 20, 12, 0, 0);

  test('returns empty string for non-finite timestamps', () => {
    expect(formatRelativeMessageTime(Number.NaN, now)).toBe('');
    expect(formatRelativeMessageTime(now, Number.NaN)).toBe('');
    expect(formatRelativeMessageTime(Number.POSITIVE_INFINITY, now)).toBe('');
  });

  test('returns "Just now" for elapsed under one minute', () => {
    expect(formatRelativeMessageTime(now - 30_000, now)).toBe('Just now');
    expect(formatRelativeMessageTime(now, now)).toBe('Just now');
  });

  test('returns "{count}m ago" for elapsed under one hour', () => {
    expect(formatRelativeMessageTime(now - 5 * MINUTE, now)).toBe('5m ago');
    expect(formatRelativeMessageTime(now - 59 * MINUTE, now)).toBe('59m ago');
  });

  test('returns combined "{hours}h {minutes}m ago" for elapsed >= one hour and < one day', () => {
    expect(formatRelativeMessageTime(now - 90 * MINUTE, now)).toBe('1h 30m ago');
    expect(formatRelativeMessageTime(now - (2 * HOUR + 15 * MINUTE), now)).toBe('2h 15m ago');
    expect(formatRelativeMessageTime(now - 13 * HOUR - 20 * MINUTE, now)).toBe('13h 20m ago');
  });

  test('returns "{days}d {hours}h {minutes}m ago" for elapsed >= one day', () => {
    expect(formatRelativeMessageTime(now - DAY - 2 * HOUR - 5 * MINUTE, now)).toBe('1d 2h 5m ago');
    expect(formatRelativeMessageTime(now - 3 * DAY - 4 * HOUR - 30 * MINUTE, now)).toBe('3d 4h 30m ago');
  });

  test('treats future timestamps as "Just now"', () => {
    expect(formatRelativeMessageTime(now + 10_000, now)).toBe('Just now');
  });
});
