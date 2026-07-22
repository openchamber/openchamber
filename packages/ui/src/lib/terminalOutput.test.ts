import { describe, expect, test } from 'bun:test';
import {
  getGhosttySafeResetSequence,
  rewriteGhosttyDefaultBackgroundResets,
} from './terminalOutput';

describe('terminal output compatibility', () => {
  test('builds an explicit default-background reset from supported CSS colors', () => {
    expect(getGhosttySafeResetSequence('#f8f7f0')).toBe('\u001b[0;48;2;248;247;240m');
    expect(getGhosttySafeResetSequence('#abc')).toBe('\u001b[0;48;2;170;187;204m');
    expect(getGhosttySafeResetSequence('rgb(12, 34, 56)')).toBe('\u001b[0;48;2;12;34;56m');
    expect(getGhosttySafeResetSequence('var(--surface-background)')).toBeNull();
  });

  test('rewrites default resets even when escape sequences span chunks', () => {
    const safeReset = '\u001b[0;48;2;10;20;30m';
    const first = rewriteGhosttyDefaultBackgroundResets('before\u001b[', '', safeReset);
    const second = rewriteGhosttyDefaultBackgroundResets('0mafter\u001b[m', first.carry, safeReset);

    expect(first).toEqual({ data: 'before', carry: '\u001b[' });
    expect(second).toEqual({ data: `${safeReset}after${safeReset}`, carry: '' });
  });

  test('preserves output when the background cannot be resolved', () => {
    expect(rewriteGhosttyDefaultBackgroundResets('0m', '\u001b[', null)).toEqual({
      data: '\u001b[0m',
      carry: '',
    });
  });
});
