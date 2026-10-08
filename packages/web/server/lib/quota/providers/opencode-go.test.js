import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-opencode-go-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDataDirectory;

import {
  fetchConsoleGoUsage,
  fetchOpenCodeGoUsage,
  fetchQuota,
  isConfigured,
  parseConsoleGoUsage,
  parseOpenCodeGoUsage,
} from './opencode-go.js';

const apiKeyAuth = () => ({ 'opencode-go': { key: 'test-key' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
});

const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_STATUS_URL = `${CONSOLE_SERVER}/api/go/status`;

const consoleAuth = (overrides = {}) => ({
  opencode: {
    type: 'oauth',
    access: 'console-access',
    refresh: 'console-refresh',
    expires: Date.now() + 3_600_000,
    server: CONSOLE_SERVER,
    orgID: 'org_TESTORG123',
    ...overrides,
  },
});

const consolePayload = ({ product = 'go', meters } = {}) => ({
  product,
  access: {
    meters: meters ?? {
      fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000000000', usedMicroCents: '250000000' },
      week: { resetsAt: '2026-08-19T12:00:00.000Z', limitMicroCents: '2000000000', usedMicroCents: '800000000' },
      month: { resetsAt: '2026-09-01T00:00:00.000Z', limitMicroCents: '6000000000', usedMicroCents: '3000000000' },
    },
  },
});

describe('OpenCode Go quota provider — legacy API key', () => {
  it('parses partial API usage windows', () => {
    const windows = parseOpenCodeGoUsage({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' }, weekly: { percent: 40, resetsAt: '2026-08-19T12:00:00.000Z' } } });
    expect(windows['5h'].usedPercent).toBe(25);
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-08-12T12:00:00.000Z'));
    expect(windows.weekly.usedPercent).toBe(40);
    expect(windows.monthly).toBeUndefined();
  });

  it('returns numeric reset timestamps for all usage windows', async () => {
    const resetsAt = '2026-10-01T00:00:00.000Z';
    const windows = await fetchOpenCodeGoUsage('test-key', async () => new Response(JSON.stringify({
      usage: {
        rolling: { percent: 25, resetsAt },
        weekly: { percent: 40, resetsAt },
        monthly: { percent: 60, resetsAt },
      },
    })));
    expect(Object.keys(windows)).toEqual(['5h', 'weekly', 'monthly']);
    for (const window of Object.values(windows)) {
      expect(window.resetAt).toBe(Date.parse(resetsAt));
    }
  });

  it('preserves valid windows when another reset date is invalid', () => {
    const windows = parseOpenCodeGoUsage({ usage: {
      rolling: { percent: 25, resetsAt: 'invalid' },
      weekly: { percent: 40, resetsAt: '2026-08-19T12:00:00.000Z' },
      monthly: { percent: 60, resetsAt: null },
    } });
    expect(Object.keys(windows)).toEqual(['weekly']);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-08-19T12:00:00.000Z'));
  });

  it('does not expose credentials in authentication errors', async () => {
    await expect(fetchOpenCodeGoUsage('secret', async () => new Response('', { status: 403 }))).rejects.toThrow('authentication failed');
  });

  it('uses the Go usage API with bearer authentication', async () => {
    let request;
    const usage = await fetchOpenCodeGoUsage('secret', async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } }));
    });
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(request.options.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      'x-opencode-session': 'openchamber-usage',
    });
    expect(request.options.headers.Cookie).toBeUndefined();
    expect(usage['5h'].usedPercent).toBe(25);
  });

  it('reads the API key from the OpenCode auth file', async () => {
    const legacyPath = path.join(temporaryDataDirectory, 'quota', 'opencode-go.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not valid json', { mode: 0o600 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth() });
    expect(result).toMatchObject({ providerId: 'opencode-go', ok: true, configured: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('still uses the API-key path when the Console integration is not a Console sign-in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ usage: { rolling: { percent: 10, resetsAt: '2026-08-12T12:00:00.000Z' } } })));
    const result = await fetchQuota({
      readAuth: async () => ({
        ...consoleAuth({ server: 'https://example.com/console' }),
        'opencode-go': { key: 'test-key' },
      }),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://opencode.ai/zen/go/v1/usage');
  });
});

describe('OpenCode Go quota provider — Console OAuth', () => {
  it('maps fiveHour, week, and month to the existing windows from decimal strings', () => {
    const windows = parseConsoleGoUsage(consolePayload());
    expect(Object.keys(windows)).toEqual(['5h', 'weekly', 'monthly']);
    expect(windows['5h'].usedPercent).toBe(25);
    expect(windows.weekly.usedPercent).toBe(40);
    expect(windows.monthly.usedPercent).toBe(50);
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-08-12T12:00:00.000Z'));
  });

  it('supports Go Plus', async () => {
    const result = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response(JSON.stringify(consolePayload({ product: 'go-plus' }))),
    });
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
  });

  it('skips only the unusable meters and keeps the rest', () => {
    const windows = parseConsoleGoUsage(consolePayload({ meters: {
      fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '0', usedMicroCents: '10' },
      week: { resetsAt: '2026-08-19T12:00:00.000Z', limitMicroCents: 'not-a-number', usedMicroCents: '10' },
      month: { resetsAt: '2026-09-01T00:00:00.000Z', limitMicroCents: '1000', usedMicroCents: '250' },
    } }));
    expect(Object.keys(windows)).toEqual(['monthly']);
    expect(windows.monthly.usedPercent).toBe(25);
  });

  it('skips a window with an invalid reset timestamp and handles missing meters', () => {
    const windows = parseConsoleGoUsage(consolePayload({ meters: {
      fiveHour: { resetsAt: 'not-a-date', limitMicroCents: '1000', usedMicroCents: '250' },
      week: { resetsAt: '2026-08-19T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents: '250' },
    } }));
    expect(Object.keys(windows)).toEqual(['weekly']);
    expect(parseConsoleGoUsage({ product: 'go', access: {} })).toEqual({});
    expect(parseConsoleGoUsage(null)).toEqual({});
  });

  it('calls the Console Go status endpoint with the Console token and organization', async () => {
    let request;
    const windows = await fetchConsoleGoUsage(
      { access: 'console-access', orgID: 'org_TESTORG123', expires: Date.now() + 60_000 },
      async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify(consolePayload()));
      },
    );
    expect(request.url).toBe(CONSOLE_STATUS_URL);
    expect(request.options.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer console-access',
      'x-org-id': 'org_TESTORG123',
    });
    expect(request.options.headers['x-opencode-session']).toBeUndefined();
    expect(request.options.redirect).toBe('error');
    expect(windows.weekly.usedPercent).toBe(40);
  });

  it('prefers the selected Console account and organization over the legacy key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(consolePayload())));
    const result = await fetchQuota({
      readAuth: async () => ({ ...consoleAuth(), 'opencode-go': { key: 'stale-key' } }),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(CONSOLE_STATUS_URL);
    expect(fetchImpl.mock.calls[0][1].headers['x-org-id']).toBe('org_TESTORG123');
  });

  it('falls back to the legacy key when the Console read fails', async () => {
    const fetchImpl = vi.fn(async (url) => (url === CONSOLE_STATUS_URL
      ? new Response(JSON.stringify(consolePayload({ product: 'zen' })))
      : new Response(JSON.stringify({ usage: { rolling: { percent: 10, resetsAt: '2026-08-12T12:00:00.000Z' } } }))));
    const result = await fetchQuota({
      readAuth: async () => ({ ...consoleAuth(), 'opencode-go': { key: 'test-key' } }),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(10);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([CONSOLE_STATUS_URL, 'https://opencode.ai/zen/go/v1/usage']);
  });

  it('reports the Console error when there is no key to fall back to', async () => {
    const result = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response(JSON.stringify(consolePayload({ product: 'zen' }))),
    });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
  });

  it('reports an unconfigured provider without requesting', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchQuota({ readAuth: async () => ({}), fetchImpl });
    expect(result).toEqual(expect.objectContaining({ ok: false, configured: false, error: 'Not configured' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an unconfigured provider when the Console sign-in is for another server or has no organization', async () => {
    expect(isConfigured(consoleAuth({ server: 'https://example.com/console' }))).toBe(false);
    expect(isConfigured(consoleAuth({ orgID: 'not-an-org' }))).toBe(false);
    expect(isConfigured(consoleAuth())).toBe(true);
    expect(isConfigured({ 'opencode-go': { key: 'test-key' } })).toBe(true);
  });

  it('distinguishes an expired sign-in without sending the stale token', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchQuota({
      readAuth: async () => consoleAuth({ expires: Date.now() - 1_000 }),
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/sign-in expired/i);
  });

  it('surfaces a 401 as an expired sign-in', async () => {
    const result = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response('', { status: 401 }),
    });
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/sign-in expired/i);
  });

  it('distinguishes an absent subscription from a malformed response', async () => {
    const absent = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response(JSON.stringify({ product: 'free', access: { meters: {} } })),
    });
    expect(absent.configured).toBe(true);
    expect(absent.error).toMatch(/subscription/i);

    const malformed = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    expect(malformed.configured).toBe(true);
    expect(malformed.error).toMatch(/unreadable/i);
  });

  it('reports a temporary request failure as configured', async () => {
    const result = await fetchQuota({
      readAuth: async () => consoleAuth(),
      fetchImpl: async () => new Response('', { status: 502 }),
    });
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/HTTP 502/);
  });

  it('follows the selected account on every read instead of caching usage', async () => {
    let call = 0;
    const seen = [];
    const result = await fetchQuota({
      readAuth: async () => {
        call += 1;
        return consoleAuth({ orgID: call === 1 ? 'org_FIRST123' : 'org_SECOND123' });
      },
      fetchImpl: async (_url, options) => {
        seen.push(options.headers['x-org-id']);
        return new Response(JSON.stringify(consolePayload({ meters: {
          fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents: call === 1 ? '250' : '900' },
        } })));
      },
    });
    expect(seen).toEqual(['org_FIRST123']);
    expect(result.usage.windows['5h'].usedPercent).toBe(25);

    const second = await fetchQuota({
      readAuth: async () => consoleAuth({ orgID: 'org_SECOND123' }),
      fetchImpl: async () => new Response(JSON.stringify(consolePayload({ meters: {
        fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents: '900' },
      } }))),
    });
    expect(second.usage.windows['5h'].usedPercent).toBe(90);
  });
});
