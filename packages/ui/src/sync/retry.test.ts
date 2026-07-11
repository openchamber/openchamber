import { describe, expect, test } from 'bun:test';

import { retry } from './retry';

describe('retry', () => {
  test('retries the timeout error emitted by AbortSignal.timeout', async () => {
    let attempts = 0;

    const value = await retry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('experimental.session.list failed: signal timed out');
      }
      return 'recovered';
    }, { attempts: 3, delay: 0 });

    expect(value).toBe('recovered');
    expect(attempts).toBe(3);
  });
});
