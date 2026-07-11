import { describe, expect, test } from 'bun:test';

import { shouldApplyDirectoryChange } from './directoryChange';

describe('shouldApplyDirectoryChange', () => {
  test('rejects a repeated resolved directory so startup hydration does not persist it again', () => {
    expect(shouldApplyDirectoryChange('/repo/app', '/repo/app')).toBe(false);
  });

  test('accepts an actual directory transition', () => {
    expect(shouldApplyDirectoryChange('/repo/app', '/repo/other')).toBe(true);
  });
});
