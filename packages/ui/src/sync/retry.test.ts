import { describe, expect, test } from 'bun:test';

import { retry } from './retry';

describe('retry transient classification (#2470)', () => {
  test("'terminated' (undici half-open socket teardown) is retried", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new TypeError('terminated');
      }),
    ).rejects.toThrow('terminated');
    expect(attempts).toBe(3);
  });

  test("normalized 'request timed out' (SDK read timeout) is retried", async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new Error('OpenCode request timed out after 30000ms');
      }),
    ).rejects.toThrow('request timed out');
    expect(attempts).toBe(3);
  });

  test('caller-initiated abort (AbortError) is NOT retried', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new DOMException('Aborted', 'AbortError');
      }),
    ).rejects.toThrow('Aborted');
    expect(attempts).toBe(1);
  });
});
