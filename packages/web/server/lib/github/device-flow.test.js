import { describe, expect, it, vi } from 'vitest';
import { exchangeDeviceCode, startDeviceFlow } from './device-flow.js';

describe('GitHub device flow', () => {
  it('starts with redirect rejection and a bounded timeout', async () => {
    const fetch = vi.fn(async () => Response.json({
      device_code: 'provider-secret',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 300,
      interval: 5,
    }));

    await expect(startDeviceFlow({ clientId: 'client', scope: 'repo', fetch, timeoutMs: 1234 }))
      .resolves.toMatchObject({ device_code: 'provider-secret' });
    expect(fetch).toHaveBeenCalledWith('https://github.com/login/device/code', expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      body: 'client_id=client&scope=repo',
    }));
  });

  it('rejects malformed provider grants', async () => {
    const fetch = vi.fn(async () => Response.json({ user_code: 'missing-device-code' }));

    await expect(startDeviceFlow({ clientId: 'client', scope: 'repo', fetch }))
      .rejects.toThrow('Invalid GitHub device flow response');
  });

  it('never sends a device exchange across redirects', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'authorization_pending' }));

    await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch });

    expect(fetch).toHaveBeenCalledWith('https://github.com/login/oauth/access_token', expect.objectContaining({
      redirect: 'error',
      body: expect.stringContaining('device_code=provider-secret'),
    }));
  });
});
