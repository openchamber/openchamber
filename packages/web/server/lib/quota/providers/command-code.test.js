import { describe, expect, it, vi } from 'vitest';

import { fetchCommandCodeUsage, fetchQuota, parseCommandCodeCredits } from './command-code.js';

const creditsPayload = {
  credits: { monthlyCredits: 4, purchasedCredits: 30, freeCredits: 5 },
  windowLimits: {
    fiveHour: { used: 25, cap: 100, resetAt: 1_776_000_000 },
    weekly: { used: 70, cap: 200, resetAt: 1_776_604_800 },
  },
};

describe('Command Code quota provider', () => {
  it('parses balances and rate-limit windows', () => {
    const windows = parseCommandCodeCredits(creditsPayload);
    expect(windows.monthly).toMatchObject({ usedPercent: 60, valueLabel: '6 / 10' });
    expect(windows.monthly_credits).toBeUndefined();
    expect(windows.purchased_credits).toMatchObject({ usedPercent: null, valueLabel: '30' });
    expect(windows.free_credits).toMatchObject({ usedPercent: null, valueLabel: '5' });
    expect(windows['5h']).toMatchObject({ usedPercent: 25, valueLabel: '25 / 100', resetAt: 1_776_000_000_000 });
    expect(windows.weekly.usedPercent).toBe(35);
  });

  it('formats fractional credit values for display', () => {
    const windows = parseCommandCodeCredits({
      credits: { monthlyCredits: 3.1052929966 },
      windowLimits: { fiveHour: { used: 0.2052929966, cap: 14 } },
    });
    expect(windows.monthly.valueLabel).toBe('6.89 / 10');
    expect(windows.monthly.usedPercent).toBeCloseTo(68.95, 2);
    expect(windows['5h'].valueLabel).toBe('0.21 / 14');
  });

  it('derives the monthly plan window from remaining included credits', () => {
    const windows = parseCommandCodeCredits({ credits: { monthlyCredits: 0.0982045034 } });
    expect(windows.monthly.usedPercent).toBeCloseTo(99.02, 2);
    expect(windows.monthly.valueLabel).toBe('9.9 / 10');
  });

  it('omits the monthly window when remaining credits exceed the plan cap', () => {
    const windows = parseCommandCodeCredits({ credits: { monthlyCredits: 250 } });
    expect(windows.monthly).toBeUndefined();
  });

  it('resolves the organization before fetching credits', async () => {
    const requests = [];
    const windows = await fetchCommandCodeUsage('secret', async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('/alpha/whoami') ? { org: { id: 'org/a' } } : creditsPayload));
    });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits?orgId=org%2Fa',
    ]);
    expect(requests[0].options.headers.Authorization).toBe('Bearer secret');
    expect(windows['5h'].usedPercent).toBe(25);
  });

  it('fetches account-scoped credits without orgId for personal accounts', async () => {
    const urls = [];
    await fetchCommandCodeUsage('secret', async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(url.endsWith('/alpha/whoami') ? { user: { id: 'user-1' }, org: null } : creditsPayload));
    });
    expect(urls).toEqual([
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits',
    ]);
  });

  it('does not expose credentials in authentication errors', async () => {
    await expect(fetchCommandCodeUsage('secret', async () => new Response('', { status: 401 }))).rejects.toThrow('authentication failed');
  });

  it('reads OAuth access credentials from the OpenCode auth file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ org: { id: 'org-1' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
    const result = await fetchQuota({
      readAuth: async () => ({ 'command-code': { type: 'oauth', access: 'test-token' } }),
      fetchImpl: fetchMock,
    });
    expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('recognizes Command Code auth entries under supported provider ID variants', async () => {
    for (const providerId of ['commandcode', 'command_code', 'command code']) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ org: { id: 'org-1' } })))
        .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
      const result = await fetchQuota({
        readAuth: async () => ({ [providerId]: { type: 'oauth', access: 'test-token' } }),
        fetchImpl: fetchMock,
      });
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
    }
  });

  it('reports not configured when no credential is stored', async () => {
    const result = await fetchQuota({ readAuth: async () => ({}) });
    expect(result).toMatchObject({ providerId: 'command-code', ok: false, configured: false });
  });
});
