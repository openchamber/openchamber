import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocationCatalog } from './location-plugins.js';

const models = { data: [{ id: 'example/model' }] };
const providers = { data: [{ id: 'example' }] };
const catalog = {
  model: { list: async () => models },
  provider: { list: async () => providers },
};

const pendingUntilAbort = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

afterEach(() => vi.useRealTimers());

describe('readLocationCatalog', () => {
  it('accepts an empty inventory when the next plugin request stalls', async () => {
    vi.useFakeTimers();
    let startRetry;
    const retried = new Promise((resolve) => { startRetry = resolve; });
    let pluginReads = 0;
    const read = readLocationCatalog({
      ...catalog,
      plugin: { list: async (_, { signal }) => {
        if (++pluginReads === 1) return { data: [] };
        startRetry();
        return pendingUntilAbort(signal);
      } },
      debug: { location: { list: async () => {
        await retried;
        return [];
      } } },
    });
    const result = expect(read).resolves.toEqual([models, providers]);
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });

  it('waits for native activation even when inventory stalls and a plugin retry fails', async () => {
    vi.useFakeTimers();
    let pluginReads = 0;
    const read = readLocationCatalog({
      ...catalog,
      model: { list: async () => pluginReads === 3 ? models : { data: [] } },
      plugin: { list: async () => {
        if (++pluginReads === 2) throw new Error('Transient plugin failure');
        return { data: pluginReads === 3 ? [{}] : [] };
      } },
      debug: { location: { list: ({ signal }) => pendingUntilAbort(signal) } },
    });
    const result = expect(read).resolves.toEqual([models, providers]);
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });
});
