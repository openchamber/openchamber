import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousQuotaDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
const temporaryQuotaDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-quota-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryQuotaDataDirectory;

// readAuthFile reads ~/.local/share/opencode/auth.json via fs.readFileSync.
// Stub fs to serve a known auth entry so the providers treat themselves as
// configured and proceed straight to fetch.
const ORIGINAL_FS = { ...fs };
const AUTH = JSON.stringify({
  openai: { access: 'test-token' },
  crof: { key: 'test-token' },
  neuralwatt: { key: 'test-token' },
  'opencode-go': { key: 'test-token' },
  'command-code': { type: 'oauth', access: 'test-token' },
  'zai-coding-plan': { key: 'test-token' },
  deepseek: { key: 'test-token' },
  sub2api: { key: 'test-token' },
});
const SUB2API_CONFIG = JSON.stringify({
  provider: {
    sub2api: {
      options: { baseURL: 'https://example.com/v1' },
    },
  },
});
const FILE_CONTENTS: Record<string, string> = {};
FILE_CONTENTS[path.join(os.homedir(), '.config', 'opencode', 'config.json')] = SUB2API_CONFIG;
FILE_CONTENTS[path.join(os.homedir(), '.config', 'opencode', 'opencode.json')] = SUB2API_CONFIG;
FILE_CONTENTS[path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')] = SUB2API_CONFIG;
((fs as unknown) as { existsSync: () => boolean }).existsSync = () => true;
((fs as unknown) as { readFileSync: (filePath: string) => string }).readFileSync = (filePath: string) =>
  FILE_CONTENTS[filePath] ?? AUTH;

import { fetchQuotaForProvider } from './quotaProviders';

type MockResponseInit = { ok?: boolean; status?: number };

after(() => {
  if (previousQuotaDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousQuotaDataDirectory;
  fs.rmSync(temporaryQuotaDataDirectory, { recursive: true, force: true });
});

const mockResponse = (body: unknown, init: MockResponseInit = {}): Response => ({
  ok: 'ok' in init ? init.ok! : true,
  status: init.status ?? 200,
  json: async () => body,
} as unknown as Response);

// Documented NeuralWatt payload from https://portal.neuralwatt.com/docs/api/quota.
// plan="standard", kwh_included=20.0, kwh_used=13.9023.
const DOCUMENTED_SUBSCRIPTION_PAYLOAD = {
  snapshot_at: '2026-04-16T18:30:00Z',
  balance: { credits_remaining_usd: 32.6774, total_credits_usd: 52.34, credits_used_usd: 19.6626, accounting_method: 'energy' },
  usage: {
    lifetime: { cost_usd: 243.9145, requests: 37801, tokens: 1235477176, energy_kwh: 15.6009 },
    current_month: { cost_usd: 160.1463, requests: 23902, tokens: 1116658995, energy_kwh: 9.7278 },
  },
  limits: { overage_limit_usd: null, rate_limit_tier: 'standard' },
  subscription: {
    plan: 'standard',
    status: 'active',
    billing_interval: 'year',
    current_period_start: '2026-04-11T05:05:25Z',
    current_period_end: '2027-04-11T05:05:25Z',
    auto_renew: true,
    kwh_included: 20.0,
    kwh_used: 13.9023,
    kwh_remaining: 6.0977,
    in_overage: false,
  },
  key: { name: 'my-production-key', allowance: null },
} as const;

let ORIGINAL_FETCH: typeof globalThis.fetch;

beforeEach(() => {
  ORIGINAL_FETCH = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const stubFetchReturning = (resolver: () => Promise<unknown>): void => {
  globalThis.fetch = (async () => resolver()) as typeof fetch;
};

const stubFetchFailing = (json: () => Promise<unknown>, init: MockResponseInit): void => {
  globalThis.fetch = (async () => ({ json, ...init }) as unknown as Response) as typeof fetch;
};

describe('OpenCode Go quota provider (VS Code parity)', () => {
  test('uses the opencode-go key from auth.json', async () => {
    let request: RequestInit | undefined;
    const legacyPath = path.join(temporaryQuotaDataDirectory, 'quota', 'opencode-go.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not valid json');
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      request = init;
      return mockResponse({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(result.ok, true);
    assert.equal((request?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.throws(() => fs.statSync(legacyPath));
  });
});

describe('Command Code quota provider (VS Code parity)', () => {
  test('uses the OAuth access token and resolves server-backed limits', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return mockResponse(url.endsWith('/alpha/whoami')
        ? { org: { id: 'org/a' } }
        : { credits: { monthlyCredits: 120 }, windowLimits: { fiveHour: { used: 25, cap: 100, resetAt: 1_776_000_000 } } });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('command-code');

    assert.equal(result.ok, true);
    assert.deepEqual(requests.map(({ url }) => url), [
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits?orgId=org%2Fa',
    ]);
    assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.equal(result.usage!.windows.monthly_credits!.valueLabel, '120');
  });

  test('omits orgId for personal accounts', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return mockResponse(url.endsWith('/alpha/whoami')
        ? { user: { id: 'user-1' }, org: null }
        : { credits: { monthlyCredits: 120 } });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('command-code');

    assert.equal(result.ok, true);
    assert.deepEqual(urls, [
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits',
    ]);
  });

  test('formats fractional credit values for display', async () => {
    globalThis.fetch = (async (url: string) => mockResponse(url.endsWith('/alpha/whoami')
      ? { org: null }
      : { credits: { monthlyCredits: 69.7947070034 }, windowLimits: { fiveHour: { used: 0.2052929966, cap: 14 } } })) as typeof fetch;

    const result = await fetchQuotaForProvider('command-code');

    assert.equal(result.usage!.windows.monthly_credits!.valueLabel, '69.79');
    assert.equal(result.usage!.windows['5h']!.valueLabel, '0.21 / 14');
  });
});

describe('Crof quota provider (VS Code parity)', () => {
  test('reports credits balance as valueLabel with null percent', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ usable_requests: 450, credits: 12.3456 })));

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'crof');
    assert.equal(result.usage!.windows.credits!.usedPercent, null);
    assert.equal(result.usage!.windows.credits!.valueLabel, '$12.35');
  });

  test('tolerates missing credits field', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ usable_requests: 0 })));

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits!.valueLabel, undefined);
    assert.equal(result.usage!.windows.credits!.usedPercent, null);
  });

  test('maps 401 to session-expired with CrofAI branding', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Session expired — please re-authenticate with CrofAI');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });
});

describe('Codex quota provider (VS Code parity)', () => {
  test('surfaces spend_control individual limit for business accounts', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      plan_type: 'business',
      rate_limit: null,
      credits: { has_credits: true, unlimited: false, balance: null },
      spend_control: {
        individual_limit: {
          limit: '7500',
          used: '2674.8724080324173',
          remaining: '4825.127591967583',
          used_percent: 36,
          remaining_percent: 64,
        },
      },
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits!.usedPercent, 36);
    assert.equal(result.usage!.windows.credits!.valueLabel, '2675 / 7500 used');
  });
});

describe('Z.ai quota provider (VS Code parity)', () => {
  test('surfaces 5-hour, weekly, and MCP quota windows', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: 1785659659993 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, nextResetTime: 1787128459979 },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.usedPercent, 0);
    assert.equal(windows['5h']!.windowSeconds, 5 * 60 * 60);
    assert.equal(windows.weekly!.usedPercent, 100);
    assert.equal(windows.weekly!.windowSeconds, 7 * 24 * 60 * 60);
    assert.equal(windows.weekly!.resetAt, 1785659659993);
    assert.equal(windows['MCP Tools']!.usedPercent, 0);
    assert.equal(windows['MCP Tools']!.windowSeconds, 30 * 24 * 60 * 60);
    assert.equal(windows['MCP Tools']!.resetAt, 1787128459979);
  });
});

describe('NeuralWatt quota provider (VS Code parity)', () => {
  test('builds subscription window keyed by plan name (windowSeconds null)', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse(DOCUMENTED_SUBSCRIPTION_PAYLOAD)));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'neuralwatt');

    // Subscription window is keyed by the plan name; windowSeconds is null
    // because the API exposes no kWh window start to derive duration from.
    const window = result.usage!.windows.standard;
    assert.ok(window, 'subscription window should be defined');
    assert.ok(Math.abs((window.usedPercent as number) - (13.9023 / 20.0) * 100) < 1e-2);
    assert.equal(window.windowSeconds, null);
    assert.equal(window.resetAt, Date.parse('2027-04-11T05:05:25Z'));

    // allowance is null → credits_balance also surfaced
    assert.ok(result.usage!.windows.credits_balance, 'credits_balance should be defined');
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
  });

  test('falls back to plan_limit title when plan is missing', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, plan: null },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.ok(result.usage!.windows.plan_limit);
    assert.ok(Math.abs((result.usage!.windows.plan_limit!.usedPercent as number) - (13.9023 / 20.0) * 100) < 1e-2);
  });

  test('marks in-overage subscription as 100%, still shows credits', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, in_overage: true, kwh_used: 25.0 },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.standard;
    assert.ok(window);
    assert.equal(window!.usedPercent, 100);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
  });

  test('surfaces subscription and allowance windows (allowance keyed by period, key name in valueLabel)', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      balance: { credits_remaining_usd: 200 },
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const subWindow = result.usage!.windows.standard;
    assert.ok(subWindow);
    assert.ok(Math.abs((subWindow!.usedPercent as number) - (13.9023 / 20.0) * 100) < 1e-2);

    // Allowance window is keyed by the localized period label ("monthly");
    // key name flows through valueLabel for identification.
    const allowWindow = result.usage!.windows.monthly;
    assert.ok(allowWindow);
    assert.equal(allowWindow!.usedPercent, 25);
    assert.equal(allowWindow!.valueLabel, 'Prod');
    assert.equal(allowWindow!.resetAt, Date.parse('2026-08-01T00:00:00Z'));

    assert.equal(result.usage!.windows.credits_balance, undefined);
  });

  test('uses allowance effective limit = min(limit, credits_remaining + spent)', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.monthly;
    assert.ok(window);
    // effectiveLimit = min(100, 30+25) = 55; usedPercent = 25/55 * 100 ≈ 45.4545
    assert.ok(Math.abs((window!.usedPercent as number) - (25 / 55) * 100) < 1e-2);
    assert.equal(window!.windowSeconds, 30 * 86400);
    assert.equal(window!.resetAt, Date.parse('2026-08-01T00:00:00Z'));
    assert.equal(window!.valueLabel, 'prod-key');
    assert.equal(result.usage!.windows.credits_balance, undefined);
  });

  test('binds allowance ceiling to limit when limit < credits_remaining + spent', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.monthly;
    assert.ok(window);
    assert.equal(window!.usedPercent, 25);
  });

  test('uses weekly as the allowance key when period is weekly', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'weekly', spent_usd: 20, blocked: false, reset_at: '2026-07-04T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.weekly;
    assert.ok(window);
    assert.equal(window!.windowSeconds, 604800);
    assert.equal(window!.resetAt, Date.parse('2026-07-04T00:00:00Z'));
    assert.equal(window!.valueLabel, 'Prod');
  });

  test('uses daily as the allowance key when period is daily', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 10, period: 'daily', spent_usd: 2, blocked: false, reset_at: '2026-07-04T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.daily;
    assert.ok(window);
    assert.equal(window!.windowSeconds, 86400);
    assert.equal(window!.resetAt, Date.parse('2026-07-04T00:00:00Z'));
  });

  test('falls back to billing_cycle when allowance period is missing or unknown', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'fortnightly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.billing_cycle;
    assert.ok(window);
    assert.equal(window!.usedPercent, 25);
  });

  test('marks blocked allowance as 100% with valueLabel set', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'sample',
        allowance: { limit_usd: 50, period: 'monthly', spent_usd: 10, blocked: true, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.monthly;
    assert.ok(window);
    assert.equal(window!.usedPercent, 100);
    assert.equal(window!.valueLabel, 'sample');
  });

  test('falls back to credits_balance when neither subscription nor allowance exists', async () => {
    const payload = {
      balance: { credits_remaining_usd: 32.6774 },
      subscription: null,
      key: { name: 'sample', allowance: null },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
    assert.equal(result.usage!.windows.credits_balance!.usedPercent, null);
  });

  test('maps 401 to session-expired', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Session expired — please re-authenticate with NeuralWatt');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });

  test('returns no-quota-data on a 200 payload with no usable windows', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      balance: { credits_remaining_usd: null },
      subscription: null,
      key: { name: 'sample', allowance: null },
    })));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });

  // Restore fs so other test files (which use the real auth file) are unaffected.
});

describe('DeepSeek quota provider (VS Code parity)', () => {
  beforeEach(() => {
    const fsMock = fs as unknown as { existsSync: () => boolean; readFileSync: () => string };
    fsMock.existsSync = () => true;
    fsMock.readFileSync = () => AUTH;
  });

  test('builds credits_balance window from documented USD payload (string balance)', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '7.54', granted_balance: '0.00', topped_up_balance: '7.54' },
      ],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'deepseek');
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$7.54');
    assert.equal(result.usage!.windows.credits_balance!.usedPercent, null);
    assert.equal(result.usage!.windows.credits_balance!.windowSeconds, null);
    assert.equal(result.usage!.windows.credits_balance!.resetAt, null);
  });

  test('falls back to CNY entry with ¥ symbol when no USD entry is present', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '100.00', granted_balance: '0.00', topped_up_balance: '100.00' },
      ],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '¥100.00');
  });

  test('maps 401 to session-expired', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Session expired — please re-authenticate with DeepSeek');
  });

  test('reports a normalized timeout error', async () => {
    stubFetchReturning(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Request timed out');
  });

  test('returns no-quota-data on a 200 payload with no usable balance', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '', granted_balance: '0.00', topped_up_balance: '0.00' }],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });

  test('keeps a literal zero balance as a valid valueLabel', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$0.00');
  });
});


describe('Sub2API quota provider (VS Code parity)', () => {
  before(() => {
    // The DeepSeek suite re-stubs readFileSync to return only AUTH; re-establish
    // the config/auth file mapping for this suite.
    ((fs as unknown) as { existsSync: () => boolean }).existsSync = () => true;
    ((fs as unknown) as { readFileSync: (filePath: string) => string }).readFileSync = (filePath: string) =>
      FILE_CONTENTS[filePath] ?? AUTH;
  });

  test('requests the normalized /v1/usage URL with Authorization only', async () => {
    let requestUrl: string | undefined;
    let requestHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestUrl = url;
      requestHeaders = init?.headers as Record<string, string> | undefined;
      return mockResponse({ mode: 'unrestricted', balance: 10, unit: 'USD' });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, true);
    assert.equal(requestUrl, 'https://example.com/v1/usage');
    assert.equal(requestHeaders?.Authorization, 'Bearer test-token');
    assert.equal(requestHeaders?.['X-Gateway-Token'], undefined);
  });

  test('parses quota_limited windows and statistics', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      mode: 'quota_limited',
      isValid: true,
      status: 'active',
      quota: { limit: 100, used: 36.5, remaining: 63.5, unit: 'USD' },
      remaining: 63.5,
      unit: 'USD',
      rate_limits: [
        { window: '5h', limit: 10, used: 4, remaining: 6, window_start: '2026-08-13T00:00:00Z', reset_at: '2026-08-13T05:00:00Z' },
        { window: '7d', limit: 100, used: 40, remaining: 60, window_start: '2026-08-11T00:00:00Z', reset_at: '2026-08-18T00:00:00Z' },
      ],
      usage: {
        today: { requests: 10, input_tokens: 10000, output_tokens: 2000, cache_read_tokens: 5000, total_tokens: 17000, actual_cost: 0.4 },
        total: { requests: 100, input_tokens: 100000, output_tokens: 20000, cache_read_tokens: 50000, total_tokens: 170000, actual_cost: 4 },
      },
      model_stats: [
        { model: 'gpt-example', requests: 20, input_tokens: 50000, output_tokens: 10000, cache_read_tokens: 20000, total_tokens: 80000, actual_cost: 2, account_cost: 1.5 },
      ],
    })));

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'sub2api');

    const total = result.usage!.windows.plan_limit;
    assert.ok(Math.abs((total!.usedPercent as number) - 36.5) < 1e-2);
    assert.equal(total!.usedLabel, '$36.50');
    assert.equal(total!.remainingLabel, '$63.50');

    const fiveHour = result.usage!.windows['5h'];
    assert.equal(fiveHour!.usedPercent, 40);
    assert.equal(fiveHour!.windowSeconds, 5 * 60 * 60);
    assert.equal(fiveHour!.resetAt, Date.parse('2026-08-13T05:00:00Z'));

    const sevenDay = result.usage!.windows['7d'];
    assert.equal(sevenDay!.windowSeconds, 7 * 24 * 60 * 60);

    assert.equal(result.statistics?.unit, 'USD');
    assert.equal(result.statistics?.today?.requests, 10);
    assert.equal(result.statistics?.total?.actualCost, 4);
    assert.equal(result.statistics?.models?.['gpt-example']?.actualCost, 2);
  });

  test('parses subscription limits with weekly reset and plan balance', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      mode: 'unrestricted',
      isValid: true,
      planName: 'Plan Name',
      unit: 'USD',
      remaining: 10,
      subscription: {
        daily_usage_usd: 1,
        weekly_usage_usd: 4,
        monthly_usage_usd: 12,
        daily_limit_usd: 5,
        weekly_limit_usd: 20,
        monthly_limit_usd: 50,
        weekly_window_start: '2026-08-10T00:00:00Z',
        expires_at: '2026-09-01T00:00:00Z',
      },
    })));

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.daily!.usedPercent, 20);
    assert.equal(result.usage!.windows.weekly!.usedPercent, 20);
    assert.equal(result.usage!.windows.weekly!.resetAt, Date.parse('2026-08-17T00:00:00Z'));
    assert.equal(result.usage!.windows.monthly!.usedPercent, 24);
    assert.equal(result.usage!.windows.monthly!.remainingLabel, '$38.00');
    assert.equal(result.usage!.windows['Plan Name']!.valueLabel, '$10.00');
  });

  test('parses wallet balance as a non-percent value', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      mode: 'unrestricted',
      isValid: true,
      planName: '钱包余额',
      remaining: 23.45,
      balance: 23.45,
      unit: 'USD',
    })));

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.usedPercent, null);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$23.45');
  });

  test('keeps quota_exhausted status as a successful result', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      mode: 'quota_limited',
      status: 'quota_exhausted',
      isValid: false,
      quota: { limit: 100, used: 100, remaining: 0, unit: 'USD' },
    })));

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'quota_exhausted');
    assert.equal(result.usage!.windows.plan_limit!.usedPercent, 100);
  });

  test('maps 401 to authentication failure', async () => {
    stubFetchFailing(async () => ({ code: 'INVALID_API_KEY' }), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Sub2API authentication failed');
  });

  test('maps 429 to an HTTP error', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 429 });

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Sub2API usage API returned HTTP 429');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });

  test('returns no-quota-data on a 200 payload with no usable windows', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ mode: 'unrestricted' })));

    const result = await fetchQuotaForProvider('sub2api');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });
});

  test('teardown: restore fs', () => {
    const fsMock = fs as unknown as { existsSync: unknown; readFileSync: unknown };
    fsMock.existsSync = ORIGINAL_FS.existsSync;
    fsMock.readFileSync = ORIGINAL_FS.readFileSync;
  });
