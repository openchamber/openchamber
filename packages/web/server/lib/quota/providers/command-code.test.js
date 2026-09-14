import { describe, expect, it, vi } from 'vitest';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { aliases, fetchCommandCodeUsage, fetchQuota, parseCommandCodeCredits, readCommandCodeCliApiKey } from './command-code.js';

const creditsPayload = {
  credits: { monthlyCredits: 120, purchasedCredits: 30, freeCredits: 5 },
  windowLimits: {
    fiveHour: { used: 25, cap: 100, resetAt: 1_776_000_000 },
    weekly: { used: 70, cap: 200, resetAt: 1_776_604_800 },
  },
};

const summaryPayload = { totalMonthlyCredits: 80 };

const jsonResponse = (payload) => new Response(JSON.stringify(payload));

describe('Command Code quota provider', () => {
  it('parses five-hour and weekly limits as percentages without labels', () => {
    const windows = parseCommandCodeCredits(creditsPayload);
    expect(windows['5h']).toMatchObject({ usedPercent: 25, windowSeconds: 18_000, resetAt: 1_776_000_000_000 });
    expect(windows['5h']).not.toHaveProperty('valueLabel');
    expect(windows.weekly).toMatchObject({ usedPercent: 35, windowSeconds: 604_800 });
    expect(windows.weekly).not.toHaveProperty('valueLabel');
  });

  it('omits purchased, free, and monthly balance windows from the credits payload', () => {
    const windows = parseCommandCodeCredits(creditsPayload);
    expect(windows).not.toHaveProperty('purchased_credits');
    expect(windows).not.toHaveProperty('free_credits');
    expect(windows).not.toHaveProperty('monthly_credits');
  });

  it('computes monthly usage from summary used plus remaining credits', async () => {
    const requests = [];
    const windows = await fetchCommandCodeUsage('secret', async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/alpha/whoami')) return jsonResponse({ org: { id: 'org/a' } });
      if (url.endsWith('/alpha/usage/summary')) return jsonResponse(summaryPayload);
      return jsonResponse(creditsPayload);
    });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits?orgId=org%2Fa',
      'https://api.commandcode.ai/alpha/usage/summary',
    ]);
    expect(requests[0].options.headers.Authorization).toBe('Bearer secret');
    expect(windows.monthly_credits).toMatchObject({ usedPercent: 40 });
    expect(windows.monthly_credits).not.toHaveProperty('valueLabel');
    expect(Object.keys(windows).sort()).toEqual(['5h', 'monthly_credits', 'weekly']);
  });

  it('falls back to the remaining monthly balance when the summary is unavailable', async () => {
    const windows = await fetchCommandCodeUsage('secret', async (url) => {
      if (url.endsWith('/alpha/whoami')) return jsonResponse({ org: { id: 'org-1' } });
      if (url.endsWith('/alpha/usage/summary')) return new Response('', { status: 503 });
      return jsonResponse({ credits: { monthlyCredits: 69.7947070034 }, windowLimits: creditsPayload.windowLimits });
    });
    expect(windows.monthly_credits).toMatchObject({ usedPercent: null, valueLabel: '69.79' });
  });

  it('falls back to the remaining monthly balance when the summary is unparseable', async () => {
    const windows = await fetchCommandCodeUsage('secret', async (url) => {
      if (url.endsWith('/alpha/whoami')) return jsonResponse({ org: { id: 'org-1' } });
      if (url.endsWith('/alpha/usage/summary')) return jsonResponse(null);
      return jsonResponse(creditsPayload);
    });
    expect(windows.monthly_credits).toMatchObject({ usedPercent: null, valueLabel: '120' });
  });

  it('fetches account-scoped credits without orgId for personal accounts', async () => {
    const urls = [];
    await fetchCommandCodeUsage('secret', async (url) => {
      urls.push(url);
      if (url.endsWith('/alpha/whoami')) return jsonResponse({ user: { id: 'user-1' }, org: null });
      if (url.endsWith('/alpha/usage/summary')) return jsonResponse(summaryPayload);
      return jsonResponse(creditsPayload);
    });
    expect(urls).toEqual([
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/usage/summary',
    ]);
  });

  it('rejects identity responses without an explicit account scope', async () => {
    await expect(fetchCommandCodeUsage('secret', async () => jsonResponse({ user: { id: 'user-1' } }))).rejects.toThrow('account could not be determined');
    await expect(fetchCommandCodeUsage('secret', async () => jsonResponse({ org: {} }))).rejects.toThrow('account could not be determined');
    await expect(fetchCommandCodeUsage('secret', async () => jsonResponse({ org: { id: '   ' } }))).rejects.toThrow('account could not be determined');
  });

  it('isolates endpoint failures in the provider result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    try {
      const result = await fetchQuota({ commandcode: { type: 'api', key: 'test-token' } });

      expect(result).toMatchObject({
        providerId: 'command-code',
        ok: false,
        configured: true,
        error: 'Command Code usage API returned HTTP 503',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('isolates authentication failures in the provider result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

    try {
      const result = await fetchQuota({ 'command-code': { type: 'api', key: 'test-token' } });

      expect(result).toMatchObject({
        providerId: 'command-code',
        ok: false,
        configured: true,
        error: 'Command Code authentication failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads OAuth access credentials from the OpenCode auth file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ org: { id: 'org-1' } }))
      .mockResolvedValueOnce(jsonResponse(creditsPayload))
      .mockResolvedValueOnce(jsonResponse(summaryPayload));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await fetchQuota({ 'command-code': { type: 'oauth', access: 'test-token' } });
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      expect(result.usage.windows.monthly_credits).toMatchObject({ usedPercent: 40 });
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recognizes Command Code auth entries under supported provider ID variants', async () => {
    expect(aliases).toEqual(['command-code', 'commandcode', 'command_code', 'command code']);
    for (const authProviderId of ['commandcode', 'command_code', 'command code']) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ org: { id: 'org-1' } }))
        .mockResolvedValueOnce(jsonResponse(creditsPayload))
        .mockResolvedValueOnce(jsonResponse(summaryPayload));
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await fetchQuota({ [authProviderId]: { type: 'oauth', access: 'test-token' } });
        expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('reads the API key created by cmd login', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-command-code-'));
    const authFile = path.join(directory, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ apiKey: '  cli-token  ' }));

    try {
      expect(readCommandCodeCliApiKey(authFile)).toBe('cli-token');
      expect(readCommandCodeCliApiKey(path.join(directory, 'missing.json'))).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the environment when OpenCode auth is unreadable', async () => {
    const previousApiKey = process.env.COMMAND_CODE_API_KEY;
    process.env.COMMAND_CODE_API_KEY = 'environment-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('invalid auth'); });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ org: null }))
      .mockResolvedValueOnce(jsonResponse(creditsPayload))
      .mockResolvedValueOnce(jsonResponse(summaryPayload));
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

  it('retries the next credential after an authentication failure', async () => {
    const previousApiKey = process.env.COMMAND_CODE_API_KEY;
    process.env.COMMAND_CODE_API_KEY = 'environment-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ org: null }))
      .mockResolvedValueOnce(jsonResponse(creditsPayload))
      .mockResolvedValueOnce(jsonResponse(summaryPayload));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await fetchQuota({ commandcode: { type: 'api', key: 'stale-token' } });
      expect(result).toMatchObject({ providerId: 'command-code', ok: true, configured: true });
      expect(fetchMock.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual([
        'Bearer stale-token',
        'Bearer environment-token',
        'Bearer environment-token',
        'Bearer environment-token',
      ]);
    } finally {
      if (previousApiKey === undefined) delete process.env.COMMAND_CODE_API_KEY;
      else process.env.COMMAND_CODE_API_KEY = previousApiKey;
      vi.unstubAllGlobals();
    }
  });
});
