import { describe, expect, it, vi } from 'vitest';
import { defaultGitLabClientId, exchangeGitLabDeviceCode, probeGitLabAuth } from './device-flow.js';

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
});
