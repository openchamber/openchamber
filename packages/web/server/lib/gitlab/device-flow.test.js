import { describe, expect, it, vi } from 'vitest';
import { defaultGitLabClientId, exchangeGitLabDeviceCode, probeGitLabAuth, refreshGitLabAccessToken } from './device-flow.js';

const json = (body, status = 200) => Response.json(body, { status });

describe('built-in OAuth application', () => {
  it('covers gitlab.com and leaves every other instance to its operator', () => {
    expect(defaultGitLabClientId('https://gitlab.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(defaultGitLabClientId('https://gitlab.example.com')).toBe('');
    expect(defaultGitLabClientId('http://localhost:8930')).toBe('');
    // The origin arrives normalized, so a trailing slash is not a separate case
    // the resolver has to strip - but a bare host is not an origin and must miss.
    expect(defaultGitLabClientId('gitlab.com')).toBe('');
  });
});

describe('GitLab device flow', () => {
  it('confirms GitLab before classifying a missing device endpoint as unsupported', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ version: '17.9.1' }))
      .mockResolvedValueOnce(json({ message: 'not found' }, 404));
    await expect(probeGitLabAuth({ origin: 'https://gitlab.example.com', clientId: 'client', fetch })).resolves.toMatchObject({
      confirmed: true, device: { available: false, reason: 'unsupported' }, pat: { available: true },
    });
    expect(fetch.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/version');
    expect(fetch.mock.calls[1][0]).toBe('https://gitlab.example.com/oauth/authorize_device');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: 'error' });
  });

  it('does not call a non-GitLab host unsupported based on its device endpoint', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ application: 'other' }));
    await expect(probeGitLabAuth({ origin: 'https://example.com', clientId: 'client', fetch })).resolves.toMatchObject({
      confirmed: false, device: { reason: 'not-gitlab' }, pat: { available: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognizes an authenticated GitLab version endpoint by its response marker', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(
      { message: '401 Unauthorized' },
      { status: 401, headers: { 'X-GitLab-Meta': '{"version":"1"}' } },
    ));

    await expect(probeGitLabAuth({ origin: 'https://gitlab.com', clientId: '', fetch })).resolves.toMatchObject({
      confirmed: true,
      device: { available: false, reason: 'invalid-client' },
      pat: { available: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('reports a %s version response as temporarily unavailable, not as a non-GitLab host', async (status) => {
    const fetch = vi.fn(async () => json({ message: 'busy' }, status));
    await expect(probeGitLabAuth({ origin: 'https://gitlab.example.com', clientId: 'client', fetch }))
      .rejects.toMatchObject({ kind: 'temporarily-unavailable', status });
  });

  it('does not trust an unmarked unauthorized response as GitLab', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ message: '401 Unauthorized' }, 401));

    await expect(probeGitLabAuth({ origin: 'https://example.com', clientId: '', fetch })).resolves.toMatchObject({
      confirmed: false,
      device: { reason: 'not-gitlab' },
      pat: { available: false },
    });
  });

  it('classifies invalid clients, temporary failures, and unreachable hosts distinctly', async () => {
    const invalidClient = vi.fn().mockResolvedValueOnce(json({ version: '17.9' })).mockResolvedValueOnce(json({ error: 'invalid_client' }, 400));
    await expect(probeGitLabAuth({ origin: 'https://gitlab.example.com', clientId: 'bad', fetch: invalidClient })).resolves.toMatchObject({
      device: { available: false, reason: 'invalid-client' }, pat: { available: true },
    });

    const temporary = vi.fn().mockResolvedValueOnce(json({ version: '17.9' })).mockResolvedValueOnce(json({}, 503));
    await expect(probeGitLabAuth({ origin: 'https://gitlab.example.com', clientId: 'client', fetch: temporary })).rejects.toMatchObject({ kind: 'temporarily-unavailable' });

    const unreachable = vi.fn().mockRejectedValueOnce(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }));
    await expect(probeGitLabAuth({ origin: 'https://gitlab.example.com', clientId: 'client', fetch: unreachable })).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('keeps authorization_pending and slow_down as polling states and returns successful tokens', async () => {
    for (const status of ['authorization_pending', 'slow_down']) {
      const fetch = vi.fn().mockResolvedValueOnce(json({ error: status }, 400));
      await expect(exchangeGitLabDeviceCode({ origin: 'https://gitlab.example.com', clientId: 'client', deviceCode: 'device', fetch }))
        .resolves.toEqual({ status });
    }
    const fetch = vi.fn().mockResolvedValueOnce(json({ access_token: 'oauth-token', scope: 'api' }));
    await expect(exchangeGitLabDeviceCode({ origin: 'https://gitlab.example.com', clientId: 'client', deviceCode: 'device', fetch }))
      .resolves.toEqual({ status: 'connected', accessToken: 'oauth-token', scope: 'api' });
  });

  it('keeps what renews an OAuth sign-in and trades a refresh token for a new pair', async () => {
    const origin = 'https://gitlab.example.com';
    const exchange = vi.fn().mockResolvedValueOnce(json({
      access_token: 'oauth-token', scope: 'api', refresh_token: 'refresh-1', expires_in: 7200,
    }));
    await expect(exchangeGitLabDeviceCode({ origin, clientId: 'client', deviceCode: 'device', fetch: exchange }))
      .resolves.toEqual({ status: 'connected', accessToken: 'oauth-token', scope: 'api', refreshToken: 'refresh-1', expiresIn: 7200 });

    const refresh = vi.fn().mockResolvedValueOnce(json({ access_token: 'oauth-token-2', refresh_token: 'refresh-2', expires_in: 7200 }));
    await expect(refreshGitLabAccessToken({ origin, clientId: 'client', refreshToken: 'refresh-1', fetch: refresh }))
      .resolves.toEqual({ accessToken: 'oauth-token-2', refreshToken: 'refresh-2', expiresIn: 7200 });
    expect(refresh.mock.calls[0][0]).toBe(`${origin}/oauth/token`);
    expect(Object.fromEntries(new URLSearchParams(String(refresh.mock.calls[0][1].body))))
      .toEqual({ client_id: 'client', refresh_token: 'refresh-1', grant_type: 'refresh_token' });
  });

  it('tells a rejected refresh grant apart from an instance that is down', async () => {
    const origin = 'https://gitlab.example.com';
    const rejected = vi.fn().mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(refreshGitLabAccessToken({ origin, clientId: 'client', refreshToken: 'spent', fetch: rejected }))
      .rejects.toMatchObject({ kind: 'invalid-token' });
    const down = vi.fn().mockResolvedValueOnce(json({ message: 'maintenance' }, 503));
    await expect(refreshGitLabAccessToken({ origin, clientId: 'client', refreshToken: 'live', fetch: down }))
      .rejects.toMatchObject({ kind: 'temporarily-unavailable' });
  });
});
