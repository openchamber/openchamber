import { describe, expect, test } from 'bun:test';

import { getNextRuns, isValidCronExpression } from './cron';

describe('cron helpers', () => {
  test('accepts valid cron expressions', () => {
    expect(isValidCronExpression('*/5 * * * *').valid).toBe(true);
    expect(isValidCronExpression('0 9 * * 1').valid).toBe(true);
    expect(isValidCronExpression('0 0 9 * * 1').valid).toBe(true);
  });

  test('rejects empty and invalid cron expressions', () => {
    expect(isValidCronExpression('').valid).toBe(false);
    expect(isValidCronExpression('   ').valid).toBe(false);
    expect(isValidCronExpression('abc').valid).toBe(false);
    expect(isValidCronExpression('61 * * * *').valid).toBe(false);
  });

  test('returns the requested number of next runs', () => {
    const runs = getNextRuns('*/5 * * * *', 'UTC', 3);

    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run instanceof Date && Number.isFinite(run.getTime()))).toBe(true);
  });

  test('returns an empty list for invalid expressions', () => {
    expect(getNextRuns('not cron', 'UTC')).toEqual([]);
  });
});
