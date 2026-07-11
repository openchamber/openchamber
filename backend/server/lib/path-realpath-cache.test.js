import { describe, expect, it } from 'vitest';

import { createRealpathCache } from './path-realpath-cache.js';

describe('createRealpathCache', () => {
  it('caches successful realpath lookups until the success TTL expires', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createRealpathCache({
      now: () => now,
      successTtlMs: 1_000,
      realpath: async () => {
        calls += 1;
        return `/real-${calls}`;
      },
    });

    await expect(cache.resolve('/link')).resolves.toBe('/real-1');
    await expect(cache.resolve('/link')).resolves.toBe('/real-1');
    expect(calls).toBe(1);

    now += 1_001;
    await expect(cache.resolve('/link')).resolves.toBe('/real-2');
    expect(calls).toBe(2);
  });

  it('shares in-flight realpath lookups for the same path', async () => {
    let calls = 0;
    let release = () => undefined;
    const pending = new Promise((resolve) => {
      release = () => resolve('/real/path');
    });
    const cache = createRealpathCache({
      realpath: async () => {
        calls += 1;
        return pending;
      },
    });

    const first = cache.resolve('/link/path');
    const second = cache.resolve('/link/path');
    await Promise.resolve();

    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['/real/path', '/real/path']);
  });

  it('throws realpath failures by default', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const cache = createRealpathCache({
      realpath: async () => {
        throw error;
      },
    });

    await expect(cache.resolve('/missing')).rejects.toBe(error);
  });

  it('can fall back to the original path and cache failures briefly', async () => {
    let calls = 0;
    const cache = createRealpathCache({
      fallbackOnError: true,
      failureTtlMs: 1_000,
      realpath: async () => {
        calls += 1;
        throw new Error('missing');
      },
    });

    await expect(cache.resolve('/missing')).resolves.toBe('/missing');
    await expect(cache.resolve('/missing')).resolves.toBe('/missing');
    expect(calls).toBe(1);
  });
});
