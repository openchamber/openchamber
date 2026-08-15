import { describe, expect, test } from 'bun:test';
import { formatEffortLabel } from './mobileControlsUtils';

describe('formatEffortLabel', () => {
  test('preserves configured variant names', () => {
    for (const variant of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(formatEffortLabel(variant)).toBe(variant);
    }
  });

  test('uses the default label when no variant is configured', () => {
    expect(formatEffortLabel()).toBe('Default');
  });
});
