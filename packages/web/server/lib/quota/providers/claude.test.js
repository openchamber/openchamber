import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = { value: { anthropic: { type: 'oauth', access: 'expired-access', refresh: 'refresh-token', expires: 1 } } };

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => authState.value,
  writeAuthFile: vi.fn((auth) => {
    authState.value = auth;
  }),
}));

import { fetchQuota, isConfigured } from './claude.js';

afterEach(() => {
  vi.unstubAllGlobals();
  authState.value = { anthropic: { type: 'oauth', access: 'expired-access', refresh: 'refresh-token', expires: 1 } };
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

const usagePayload = {
  five_hour: { utilization: 0.42, resets_at: '2026-08-05T12:00:00Z' },
  seven_day: { utilization: 0.15, resets_at: '2026-08-08T12:00:00Z' },
};

const mockUsageResponse = (status = 200, body = usagePayload) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

const mockTokenResponse = (status = 200, body = {}) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

const isTokenRequest = (url) => url === 'https://console.anthropic.com/v1/oauth/token';

describe('Claude quota provider OAuth renewal', () => {
  it('is not configured without any stored credential', () => {
    authState.value = {};
    expect(isConfigured()).toBe(false);
  });

  it('uses a plain token entry directly without touching the token endpoint', async () => {
    authState.value = { anthropic: { token: 'plain-token' } };
    const fetchMock = vi.fn().mockResolvedValue(mockUsageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(0.42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer plain-token');
  });

  it('renews an expired oauth token before calling the usage API and persists it', async () => {
    authState.value = {
      anthropic: { type: 'oauth', access: 'stale-access', refresh: 'refresh-token', expires: Date.now() - 60_000 },
    };
    const fetchMock = vi.fn().mockImplementation((url) => (
      isTokenRequest(url)
        ? Promise.resolve(mockTokenResponse(200, {
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }))
        : Promise.resolve(mockUsageResponse())
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(0.42);
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => isTokenRequest(url));
    expect(tokenCalls).toHaveLength(1);
    const tokenBody = JSON.parse(tokenCalls[0][1].body);
    expect(tokenBody).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    const usageCall = fetchMock.mock.calls.find(([url]) => !isTokenRequest(url));
    expect(usageCall[1].headers.Authorization).toBe('Bearer fresh-access');
    expect(authState.value.anthropic.access).toBe('fresh-access');
    expect(authState.value.anthropic.refresh).toBe('rotated-refresh');
    expect(typeof authState.value.anthropic.expires).toBe('number');
  });

  it('skips renewal while the stored token is still valid', async () => {
    authState.value = {
      anthropic: { type: 'oauth', access: 'live-access', refresh: 'refresh-token', expires: Date.now() + 3600_000 },
    };
    const fetchMock = vi.fn().mockResolvedValue(mockUsageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer live-access');
  });

  it('falls back to the jwt exp claim when the entry has no expires field', async () => {
    const futureExp = Math.floor((Date.now() + 3600_000) / 1000);
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64url');
    authState.value = {
      anthropic: { type: 'oauth', access: `header.${payload}.sig`, refresh: 'refresh-token' },
    };
    const fetchMock = vi.fn().mockResolvedValue(mockUsageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer header.${payload}.sig`);
  });

  it('retries once with a freshly renewed token when the usage API still 401s, then reports session expiry', async () => {
    authState.value = {
      anthropic: { type: 'oauth', access: 'stale-access', refresh: 'refresh-token', expires: Date.now() - 60_000 },
    };
    const fetchMock = vi.fn().mockImplementation((url) => (
      isTokenRequest(url)
        ? Promise.resolve(mockTokenResponse(200, {
          access_token: `fresh-${Math.random()}`,
          refresh_token: `rotated-${Math.random()}`,
          expires_in: 3600,
        }))
        : Promise.resolve(mockUsageResponse(401))
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Session expired — please re-authenticate with Claude');
    // renewal + retry renewal = two token exchanges, two usage attempts
    expect(fetchMock.mock.calls.filter(([url]) => isTokenRequest(url))).toHaveLength(2);
  });

  it('succeeds when the retry with a renewed token passes', async () => {
    let usageAttempts = 0;
    authState.value = {
      anthropic: { type: 'oauth', access: 'stale-access', refresh: 'refresh-token', expires: Date.now() - 60_000 },
    };
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (isTokenRequest(url)) {
        return Promise.resolve(mockTokenResponse(200, {
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }));
      }
      usageAttempts += 1;
      return Promise.resolve(mockUsageResponse(usageAttempts === 1 ? 401 : 200));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(0.42);
    expect(usageAttempts).toBe(2);
  });

  it('surfaces non-401 API errors with the status', async () => {
    authState.value = {
      anthropic: { type: 'oauth', access: 'live-access', refresh: 'refresh-token', expires: Date.now() + 3600_000 },
    };
    const fetchMock = vi.fn().mockResolvedValue(mockUsageResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 503');
  });

  it('reports session expiry for a 401 without a refresh token instead of a raw API error', async () => {
    authState.value = { anthropic: { type: 'oauth', access: 'expired-access' } };
    const fetchMock = vi.fn().mockResolvedValue(mockUsageResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with Claude');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent refreshes into a single renewal', async () => {
    authState.value = {
      anthropic: { type: 'oauth', access: 'stale-access', refresh: 'refresh-token', expires: Date.now() - 60_000 },
    };
    const fetchMock = vi.fn().mockImplementation((url) => (
      isTokenRequest(url)
        ? Promise.resolve(mockTokenResponse(200, {
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }))
        : Promise.resolve(mockUsageResponse())
    ));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([fetchQuota(), fetchQuota()]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => isTokenRequest(url));
    expect(tokenCalls).toHaveLength(1);
  });
});
