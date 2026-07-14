import { afterEach, describe, expect, it, vi } from 'vitest';

import { exchangeDeviceCode, startDeviceFlow } from './device-flow.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('github device flow URLs', () => {
  it('uses github.com by default', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ device_code: 'device' }),
    });

    await startDeviceFlow({ clientId: 'client-id', scope: 'repo' });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('uses a custom baseUrl for enterprise polling', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'token' }),
    });

    await exchangeDeviceCode({
      clientId: 'client-id',
      deviceCode: 'device-code',
      baseUrl: 'https://ghe.example.com',
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://ghe.example.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
