import { afterEach, describe, expect, it, vi } from 'vitest';

import { exchangeDeviceCode, startDeviceFlow } from './device-flow.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github device flow URLs', () => {
  it('uses github.com by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ device_code: 'device' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await startDeviceFlow({ clientId: 'client-id', scope: 'repo' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('uses a custom baseUrl for enterprise polling', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'token' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await exchangeDeviceCode({
      clientId: 'client-id',
      deviceCode: 'device-code',
      baseUrl: 'https://ghe.example.com',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ghe.example.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
