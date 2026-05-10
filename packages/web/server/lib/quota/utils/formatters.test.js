import { describe, expect, it } from 'vitest';

import { formatResetTime } from './formatters.js';

describe('formatResetTime', () => {
  it('returns null for invalid timestamps', () => {
    expect(formatResetTime('not-a-date')).toBeNull();
  });
});
