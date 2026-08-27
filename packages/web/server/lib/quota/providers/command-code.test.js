import { describe, expect, it, vi } from 'vitest';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { fetchCommandCodeUsage, fetchQuota, parseCommandCodeCredits, readCommandCodeCliApiKey } from './command-code.js';

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
  });

  it('isolates endpoint failures in the provider result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    const result = await fetchQuota({ commandcode: { type: 'api', key: 'test-token' } });

    expect(result).toMatchObject({
      providerId: 'command-code',
      ok: false,
      configured: true,
      error: 'Command Code usage API returned HTTP 503',
    });
    vi.unstubAllGlobals();
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
    for (const authProviderId of ['commandcode', 'command_code', 'command code']) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ org: { id: 'org-1' } })))
        .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchQuota({ [authProviderId]: { type: 'oauth', access: 'test-token' } });
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      vi.unstubAllGlobals();
    }
  });

  it('reads the API key created by cmd login', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-command-code-'));
    const authFile = path.join(directory, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ apiKey: '  cli-token  ' }));

    expect(readCommandCodeCliApiKey(authFile)).toBe('cli-token');
    expect(readCommandCodeCliApiKey(path.join(directory, 'missing.json'))).toBeNull();

    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('falls back to the environment when OpenCode auth is unreadable', async () => {
    const previousApiKey = process.env.COMMAND_CODE_API_KEY;
    process.env.COMMAND_CODE_API_KEY = 'environment-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('invalid auth'); });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ org: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify(creditsPayload)));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await fetchQuota();
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer environment-token');
    } finally {
      if (previousApiKey === undefined) delete process.env.COMMAND_CODE_API_KEY;
      else process.env.COMMAND_CODE_API_KEY = previousApiKey;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
