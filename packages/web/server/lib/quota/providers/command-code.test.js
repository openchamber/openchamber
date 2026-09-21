import { describe, expect, it, vi } from 'vitest';

import { fetchCommandCodeUsage, fetchQuota, parseCommandCodeCredits } from './command-code.js';

const creditsPayload = {
  credits: { monthlyCredits: 120, purchasedCredits: 30, freeCredits: 5 },
  windowLimits: {
    fiveHour: { used: 25, cap: 100, resetAt: 1_776_000_000 },
    weekly: { used: 70, cap: 200, resetAt: 1_776_604_800 },
  },
};

describe('Command Code quota provider', () => {
  it('parses balances and rate-limit windows', () => {
    const windows = parseCommandCodeCredits(creditsPayload);
    expect(windows.monthly_credits).toMatchObject({ usedPercent: null, valueLabel: '120' });
    expect(windows.purchased_credits).toMatchObject({ usedPercent: null, valueLabel: '30' });
    expect(windows.free_credits).toMatchObject({ usedPercent: null, valueLabel: '5' });
    expect(windows['5h']).toMatchObject({ usedPercent: 25, valueLabel: '25 / 100', resetAt: 1_776_000_000_000 });
    expect(windows.weekly.usedPercent).toBe(35);
  });

  it('formats fractional credit values for display', () => {
    const windows = parseCommandCodeCredits({
      credits: { monthlyCredits: 69.7947070034 },
      windowLimits: { fiveHour: { used: 0.2052929966, cap: 14 } },
    });
    expect(windows.monthly_credits.valueLabel).toBe('69.79');
    expect(windows['5h'].valueLabel).toBe('0.21 / 14');
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const result = await fetchQuota({ 'command-code': { type: 'oauth', access: 'secret' } });
    vi.unstubAllGlobals();

    expect(result).toMatchObject({ providerId: 'command-code', ok: false, configured: true, error: 'Command Code authentication failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reads OAuth access credentials from the OpenCode auth file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ org: { id: 'org-1' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchQuota({ 'command-code': { type: 'oauth', access: 'test-token' } });
    expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    vi.unstubAllGlobals();
  });

  it('recognizes Command Code auth entries under supported provider ID variants', async () => {
    for (const providerId of ['commandcode', 'command_code', 'command code']) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ org: { id: 'org-1' } })))
        .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchQuota({ [providerId]: { type: 'oauth', access: 'test-token' } });
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      vi.unstubAllGlobals();
    }
  });

  it('normalizes an inactive window resetAt of 0 to null instead of a bogus date', () => {
    const windows = parseCommandCodeCredits({
      credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 0, purchasedCredits: 2.42, freeCredits: 0 },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: { used: 0, cap: 16, exceeded: false, resetAt: 0 },
        weekly: { used: 20.11, cap: 40, exceeded: false, resetAt: 1_790_316_552_026 },
      },
    });

    expect(windows.monthly_credits.valueLabel).toBe('0');
    expect(windows.purchased_credits.valueLabel).toBe('2.42');
    expect(windows.free_credits.valueLabel).toBe('0');

    expect(windows['5h']).toMatchObject({
      usedPercent: 0,
      valueLabel: '0 / 16',
      resetAt: null,
      resetAfterSeconds: null,
      resetAtFormatted: null,
      resetAfterFormatted: null,
    });
    expect(JSON.stringify(windows['5h'])).not.toContain('Jan');

    expect(windows.weekly.resetAt).toBe(1_790_316_552_026);
    expect(windows.weekly.usedPercent).toBeCloseTo(50.275, 5);
    expect(windows.weekly.valueLabel).toBe('20.11 / 40');
  });

  it('normalizes positive epoch seconds to milliseconds and preserves milliseconds', () => {
    const windows = parseCommandCodeCredits({
      windowLimits: {
        fiveHour: { used: 1, cap: 10, resetAt: 1_776_000_000 },
        weekly: { used: 1, cap: 10, resetAt: 1_790_316_552_026 },
      },
    });
    expect(windows['5h'].resetAt).toBe(1_776_000_000_000);
    expect(windows.weekly.resetAt).toBe(1_790_316_552_026);
  });

  it('omits windows with a non-positive cap or missing used/cap', () => {
    const windows = parseCommandCodeCredits({
      credits: { monthlyCredits: 10 },
      windowLimits: {
        fiveHour: { cap: 100 },
        weekly: { used: 5, cap: 0 },
      },
    });
    expect(windows['5h']).toBeUndefined();
    expect(windows.weekly).toBeUndefined();
    expect(windows.monthly_credits.valueLabel).toBe('10');

    const negativeCap = parseCommandCodeCredits({
      windowLimits: { fiveHour: { used: 5, cap: -1 }, weekly: { used: null, cap: 10 } },
    });
    expect(negativeCap['5h']).toBeUndefined();
    expect(negativeCap.weekly).toBeUndefined();
  });
});
