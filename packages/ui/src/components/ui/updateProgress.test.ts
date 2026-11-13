import { describe, expect, test } from 'bun:test';
import { updateProgressPercent } from './updateProgress';

describe('updateProgressPercent', () => {
  test('rounds a plain downloading ratio', () => {
    expect(updateProgressPercent({ downloaded: 660, total: 980 })).toBe(67);
  });

  test('stays at 0 when main has not sent a total yet', () => {
    expect(updateProgressPercent(null)).toBe(0);
    expect(updateProgressPercent({ downloaded: 42, total: undefined })).toBe(0);
  });

  test('clamps a differential download that reports more bytes than its total', () => {
    expect(updateProgressPercent({ downloaded: 15_368, total: 980 })).toBe(100);
  });

  test('stays at 100 at completion', () => {
    expect(updateProgressPercent({ downloaded: 980, total: 980 })).toBe(100);
  });
});
