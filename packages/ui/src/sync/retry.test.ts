import { describe, expect, test } from 'bun:test';
import { retry } from './retry';

describe('retry TRANSIENT_MESSAGES (#2470)', () => {
  test('"terminated" (undici half-open socket teardown) is retried', async () => {
    let attempts = 0;
    const fn = async (): Promise<string> => {
      attempts += 1;
      throw new Error('TypeError: terminated');
    };
    await expect(retry(fn, { attempts: 3, delay: 1 })).rejects.toThrow();
    expect(attempts).toBe(3);
  });

  test('normalized "request timed out" (SDK read timeout) is retried', async () => {
    let attempts = 0;
    const fn = async (): Promise<string> => {
      attempts += 1;
      throw new Error('OpenCode request timed out after 30000ms');
    };
    await expect(retry(fn, { attempts: 3, delay: 1 })).rejects.toThrow();
    expect(attempts).toBe(3);
  });

  test('a caller-initiated abort (AbortError) is NOT retried', async () => {
    let attempts = 0;
    const fn = async (): Promise<string> => {
      attempts += 1;
      const error = new DOMException('Aborted', 'AbortError');
      throw error;
    };
    await expect(retry(fn, { attempts: 3, delay: 1 })).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
