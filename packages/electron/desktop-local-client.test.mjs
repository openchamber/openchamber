import { describe, expect, mock, test } from 'bun:test';
import { mintAndPersistDesktopLocalClient } from './desktop-local-client.mjs';

describe('mintAndPersistDesktopLocalClient', () => {
  test('mints through the in-process handle and persists the returned token', async () => {
    const createDesktopLocalClient = mock(async () => ({ token: 'oc_client_native', client: { id: 'local' } }));
    const persistToken = mock(async () => undefined);

    const token = await mintAndPersistDesktopLocalClient({
      serverHandle: { createDesktopLocalClient },
      metadata: { devicePlatform: 'macos', appVersion: '1.2.3' },
      persistToken,
    });

    expect(token).toBe('oc_client_native');
    expect(createDesktopLocalClient).toHaveBeenCalledWith({ devicePlatform: 'macos', appVersion: '1.2.3' });
    expect(persistToken).toHaveBeenCalledWith('oc_client_native');
  });

  test('fails closed when the server is not a desktop runtime', async () => {
    const persistToken = mock(async () => undefined);
    await expect(mintAndPersistDesktopLocalClient({
      serverHandle: {},
      metadata: {},
      persistToken,
    })).rejects.toThrow('native local client mint');
    expect(persistToken).not.toHaveBeenCalled();
  });
});
