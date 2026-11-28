import { describe, expect, it, vi } from 'vitest';
import { createModelCatalogReader } from './model-catalog.js';

const base = (overrides = {}) => ({
  buildOpenCodeUrl: () => 'http://127.0.0.1:4096/api/info',
  getOpenCodeAuthHeaders: () => ({}),
  ...overrides,
});

describe('model catalog reader', () => {
  it('reports an untrusted folder in the words the control layer uses', async () => {
    // The guard would answer 403 anyway; naming it here keeps the message the
    // user gets, instead of the client's `UnexpectedStatus: 403`.
    const read = createModelCatalogReader(base({
      isOpenCodeDirectoryTrusted: async () => false,
      createClient: () => { throw new Error('must not reach the runtime'); },
    }));

    await expect(read('/untrusted')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Ask the user to open the folder in OpenChamber and trust it.'),
    });
  });

  it('stands down when the runtime is not reachable', async () => {
    // A save is not the place to wait for a runtime that is not up, and no
    // catalog is not the same as a catalog that omits the model.
    const read = createModelCatalogReader(base({
      isOpenCodeDirectoryTrusted: async () => true,
      createClient: () => ({ model: { list: async () => { throw new Error('ECONNREFUSED'); } } }),
    }));

    await expect(read('/repo')).resolves.toEqual([]);
  });

  it('returns the catalog entries', async () => {
    const read = createModelCatalogReader(base({
      isOpenCodeDirectoryTrusted: async () => true,
      createClient: () => ({
        plugin: { list: async () => ({ data: [] }) },
        debug: { location: { list: async () => [] } },
        model: { list: async () => ({ data: [{ providerID: 'p', id: 'm' }] }) },
      }),
    }));

    await expect(read('/repo')).resolves.toEqual([{ providerID: 'p', id: 'm' }]);
  });

  it('does not return early models when a failed inventory leaves the location not ready', async () => {
    vi.useFakeTimers();
    try {
      const model = { list: vi.fn(async () => ({ data: [{ providerID: 'p', id: 'early' }] })) };
      const read = createModelCatalogReader(base({
        createClient: () => ({
          plugin: { list: async () => ({ data: [] }) },
          debug: { location: { list: async () => { throw new Error('Inventory unavailable'); } } },
          model,
        }),
      }));
      const reading = read('/repo');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await reading).toEqual([]);
      expect(model.list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
