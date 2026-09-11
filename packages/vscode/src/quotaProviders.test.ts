import { after, afterEach, beforeEach, describe, test } from 'node:test';
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
  'cline-pass': { key: 'test-token' },
  neuralwatt: { key: 'test-token' },
  'opencode-go': { key: 'test-token' },
  openrouter: { key: 'test-token' },
  'zai-coding-plan': { key: 'test-token' },
  deepseek: { key: 'test-token' },
  hyper: { key: 'test-token' },
  'nano-gpt': { key: 'test-token' },
  'github-copilot': { access: 'test-token' },
  anthropic: { access: 'test-token', refresh: 'test-refresh' },
});
((fs as unknown) as { existsSync: () => boolean }).existsSync = () => true;
((fs as unknown) as { readFileSync: () => string }).readFileSync = () => AUTH;

import { fetchClinePassQuota, fetchHyperQuota, fetchOllamaCloudQuota, fetchQuotaForProvider } from './quotaProviders';
import { validateCredential } from './quotaCredentials';

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

test('dispatches Charm Hyper through the generic quota API', async () => {
  stubFetchReturning(async () => Response.json({ balance: 100 }));
  const result = await fetchQuotaForProvider('hyper');
  assert.equal(result.ok, true);
  assert.equal(result.usage?.windows.credits?.valueLabel, '100');
});

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
    assert.equal((request?.headers as Record<string, string>)['x-opencode-session'], 'openchamber-usage');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.throws(() => fs.statSync(legacyPath));
  });
});

describe('OpenRouter quota provider (VS Code parity)', () => {
  const documentedPayload = {
    data: {
      label: 'test-key',
      usage: 3.17561396,
      usage_daily: 0.0000018,
      usage_weekly: 0.0000018,
      usage_monthly: 3.17561396,
      limit: 30,
      limit_remaining: 29.9999982,
      limit_reset: 'daily',
      is_free_tier: true,
      is_management_key: false,
      include_byok_in_limit: false,
      byok_usage: 0,
    },
  };

  test('reads the documented key endpoint and emits the current reset window', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestInit = init;
      return mockResponse(documentedPayload);
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(requestedUrl, 'https://openrouter.ai/api/v1/key');
    assert.equal(requestedUrl.includes('/api/v1/credits'), false);
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer test-token');
    assert.equal(new Headers(requestInit?.headers).get('Accept-Encoding'), 'identity');
    assert.ok(requestInit?.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(result.usage!.windows), ['daily']);
    assert.equal(result.usage!.windows.daily!.windowSeconds, 86400);
    assert.equal(result.usage!.windows.daily!.valueLabel, '$0.00 / $30.00');
    assert.ok(typeof result.usage!.windows.daily!.resetAt === 'number');
  });

  test('maps an unlimited null-limit key to a monthly spent window', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: null, limit_remaining: null, limit_reset: null, usage_monthly: 12.5, is_management_key: false },
    })));

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['monthly']);
    assert.equal(result.usage!.windows.monthly!.usedPercent, null);
    assert.equal(result.usage!.windows.monthly!.windowSeconds, 30 * 86400);
    assert.equal(result.usage!.windows.monthly!.valueLabel, '$12.50 spent');
    assert.ok(typeof result.usage!.windows.monthly!.resetAt === 'number');
  });

  test('maps a lifetime cap to a credits window without reset metadata', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: null, usage_monthly: 5 },
    })));

    const result = await fetchQuotaForProvider('openrouter');
    const window = result.usage!.windows.credits;

    assert.ok(window);
    assert.equal(window!.windowSeconds, null);
    assert.equal(window!.resetAt, null);
  });

  test('maps an unrecognized reset period to a credits window', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'yearly', usage_monthly: 5 },
    })));

    const result = await fetchQuotaForProvider('openrouter');

    assert.ok(result.usage!.windows.credits);
    assert.equal(result.usage!.windows.credits!.windowSeconds, null);
    assert.equal(result.usage!.windows.credits!.resetAt, null);
  });

  test('clamps percent at 100 while leaving the money label unclamped', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: -1, limit_reset: 'monthly', usage_monthly: 31 },
    })));

    const result = await fetchQuotaForProvider('openrouter');
    const window = result.usage!.windows.monthly;

    assert.equal(window!.usedPercent, 100);
    assert.equal(window!.valueLabel, '$31.00 / $30.00');
  });

  test('uses a weekly window and derives its reset on Monday UTC', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'weekly', usage_monthly: 5 },
    })));

    const result = await fetchQuotaForProvider('openrouter');
    const window = result.usage!.windows.weekly;

    assert.ok(window);
    assert.equal(window!.windowSeconds, 604800);
    assert.equal(new Date(window!.resetAt!).getUTCDay(), 1);
  });

  test('rejects management keys with an inference-key error', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ data: { is_management_key: true } })));

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, 'Management key configured — quota needs an inference API key');
  });

  for (const status of [401, 403]) {
    test(`maps HTTP ${status} to session expiry`, async () => {
      stubFetchFailing(async () => ({}), { ok: false, status });

      const result = await fetchQuotaForProvider('openrouter');

      assert.equal(result.ok, false);
      assert.equal(result.error, 'Session expired — please re-authenticate with OpenRouter');
    });
  }

  test('reports invalid JSON as a parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });

  test('normalizes timeout failures', async () => {
    stubFetchReturning(() => Promise.reject(new DOMException('Timed out', 'TimeoutError')));

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Request timed out');
  });

  test('rejects a response without usable quota data', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ data: { limit: 30, limit_remaining: null } })));

    const result = await fetchQuotaForProvider('openrouter');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, 'No quota data in response');
  });

  for (const payload of [{ data: {} }, { data: null }]) {
    test(`rejects ${JSON.stringify(payload)} without quota data`, async () => {
      stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

      const result = await fetchQuotaForProvider('openrouter');

      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.usage, null);
      assert.equal(result.error, 'No quota data in response');
    });
  }
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

describe('ClinePass quota provider (VS Code parity)', () => {
  // Live-verified response shape of
  // GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
  const documentedPayload = {
    data: {
      limits: [
        { type: 'five_hour', percentUsed: 43, resetsAt: '2026-09-08T17:00:44.598174595Z' },
        { type: 'weekly', percentUsed: 17, resetsAt: '2026-09-13T17:00:44.598174595Z' },
        { type: 'monthly', percentUsed: 8, resetsAt: '2026-10-01T00:00:00Z' },
      ],
    },
    success: true,
  };

  test('maps documented limit kinds to 5h/weekly/monthly windows', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse(documentedPayload)));

    const result = await fetchQuotaForProvider('cline-pass');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'cline-pass');
    assert.equal(result.usage?.windows['5h']?.usedPercent, 43);
    assert.equal(result.usage?.windows['5h']?.windowSeconds, 18_000);
    assert.equal(result.usage?.windows['5h']?.resetAt, Date.parse('2026-09-08T17:00:44.598174595Z'));
    assert.equal(result.usage?.windows.weekly?.usedPercent, 17);
    assert.equal(result.usage?.windows.weekly?.windowSeconds, 604_800);
    assert.equal(result.usage?.windows.monthly?.usedPercent, 8);
    assert.equal(result.usage?.windows.monthly?.windowSeconds, null);
  });

  test('ignores unknown limit types and rejects responses without quota data', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ data: { limits: [{ type: 'quarterly', percentUsed: 5 }] } })));

    const result = await fetchQuotaForProvider('cline-pass');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, 'No quota data in response');
  });

  test('maps 401 to session-expired with ClinePass branding', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('cline-pass');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Session expired — please re-authenticate with ClinePass');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    stubFetchFailing(async () => { throw new SyntaxError('Unexpected token'); }, { ok: true, status: 200 });

    const result = await fetchQuotaForProvider('cline-pass');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });

  const readAuth = () => ({ 'cline-pass': { key: 'test-token' } });

  for (const limit of [
    { type: 'constructor', percentUsed: 5 }, { type: 'toString', percentUsed: 5 },
    { type: '__proto__', percentUsed: 5 }, { type: 'weekly', percentUsed: '' },
    { type: 'weekly', percentUsed: ' ' }, { type: 'weekly', percentUsed: true },
    { type: 'weekly', percentUsed: null }, null,
  ]) {
    test(`skips malformed windows independently: ${JSON.stringify(limit)}`, async () => {
      const invalid = await fetchClinePassQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [limit] } }) });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.usage, null);
      const mixed = await fetchClinePassQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [limit, { type: 'monthly', percentUsed: 8 }] } }) });
      assert.equal(mixed.ok, true);
      assert.ok(mixed.usage);
      assert.deepEqual(Object.keys(mixed.usage.windows), ['monthly']);
    });
  }

  for (const percentUsed of [0, '0', '51']) {
    test(`accepts percentage ${JSON.stringify(percentUsed)}`, async () => {
      const result = await fetchClinePassQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [{ type: 'weekly', percentUsed }] } }) });
      assert.equal(result.ok, true);
      assert.equal(result.usage?.windows.weekly?.usedPercent, Number(percentUsed));
    });
  }

  for (const entry of [{ key: '' }, { key: ' ' }, { key: 42 }, {}]) {
    test(`falls back to a usable token: ${JSON.stringify(entry)}`, async () => {
      const result = await fetchClinePassQuota({
        readAuth: () => ({ 'cline-pass': { ...entry, token: 'test-token' } }),
        fetchImpl: async (_url, options) => {
          assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer test-token');
          return Response.json(documentedPayload);
        },
      });
      assert.equal(result.ok, true);
    });
  }

  test('does not request usage without usable credentials', async () => {
    const result = await fetchClinePassQuota({ readAuth: () => ({ 'cline-pass': { key: 42 } }), fetchImpl: async () => { throw new Error('Unexpected fetch'); } });
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Not configured');
  });

  test('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const result = await fetchClinePassQuota({ readAuth, fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, 'Request timed out');
  });
});

describe('Codex quota provider (VS Code parity)', () => {
  test('coalesces concurrent refreshes for the same provider', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let requestCount = 0;
    globalThis.fetch = (() => {
      requestCount += 1;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as typeof fetch;

    const first = fetchQuotaForProvider('codex');
    const second = fetchQuotaForProvider('codex');
    resolveResponse?.(mockResponse({ rate_limit: null }));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(requestCount, 1);
  });

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

describe('GitHub Copilot quota provider (VS Code parity)', () => {
  test('exposes only premium interactions as the primary usage window', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        chat: { entitlement: 100, remaining: 80 },
        completions: { entitlement: 1000, remaining: 900 },
        premium_interactions: { entitlement: 300, remaining: 225 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['premium_interactions']);
    assert.equal(result.usage!.windows.premium_interactions!.usedPercent, 25);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '225 / 300 left');
  });

  test('add-on path mirrors the primary window shaping', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 225 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot-addon');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['premium_interactions']);
    assert.equal(result.usage!.windows.premium_interactions!.usedPercent, 25);
  });

  test('reports unlimited plans without a percent', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { unlimited: true, entitlement: -1, remaining: -1 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.premium_interactions!.usedPercent, null);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, 'Unlimited');
  });

  test('falls back to percent_remaining when entitlement is unusable', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 75.5 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.usage!.windows.premium_interactions!.usedPercent! - 24.5) < 1e-9);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, undefined);
  });
});

describe('Claude quota provider (VS Code parity)', () => {
  test('parses current limits, model-scoped limits, and extra usage', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      limits: [
        { kind: 'session', percent: 12, resets_at: '2026-08-20T12:00:00Z', scope: null },
        { kind: 'weekly_all', percent: 34, resets_at: '2026-08-24T12:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 56, resets_at: '2026-08-24T12:00:00Z', scope: { model: { display_name: 'Sonnet' } } },
      ],
      spend: {
        enabled: true,
        percent: 25,
        used: { amount_minor: 2500, exponent: 2, currency: 'USD' },
        limit: { amount_minor: 10000, exponent: 2, currency: 'USD' },
      },
    })));

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows['5h']?.usedPercent, 12);
    assert.equal(result.usage?.windows['7d']?.usedPercent, 34);
    assert.equal(result.usage?.models?.Sonnet?.windows['7d']?.usedPercent, 56);
    assert.equal(result.usage?.windows.extra_usage?.valueLabel, '$25.00 / $100.00');
  });

  test('keeps serving the last good values while Anthropic rate limits', async () => {
    const responses = [
      mockResponse({ five_hour: { utilization: 12, resets_at: '2026-08-20T12:00:00Z' } }),
      {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '120' }),
        json: async () => ({}),
      } as Response,
    ];
    let requestCount = 0;
    globalThis.fetch = (async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    }) as typeof fetch;

    const initial = await fetchQuotaForProvider('claude');
    const rateLimited = await fetchQuotaForProvider('claude');
    const duringCooldown = await fetchQuotaForProvider('claude');

    assert.equal(initial.ok, true);
    assert.equal(rateLimited.ok, true);
    assert.equal(duringCooldown.ok, true);
    assert.equal(duringCooldown.usage?.windows['5h']?.usedPercent, 12);
    assert.equal(requestCount, 2);
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

  test('maps CREDIT_LIMIT entries to windows with credit value labels and plan level', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 65, remaining: 11934, percentage: 1, nextResetTime: 1787257978907 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 65, remaining: 59934, percentage: 1, nextResetTime: 1787844668997 },
        ],
        level: 'pro',
      },
    })));

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(result.planLabel, 'pro');
    assert.equal(windows['5h']!.usedPercent, 1);
    assert.equal(windows['5h']!.windowSeconds, 5 * 60 * 60);
    assert.equal(windows['5h']!.resetAt, 1787257978907);
    assert.equal(windows['5h']!.valueLabel, '65 / 12k credits');
    assert.equal(windows.weekly!.usedPercent, 1);
    assert.equal(windows.weekly!.windowSeconds, 7 * 24 * 60 * 60);
    assert.equal(windows.weekly!.resetAt, 1787844668997);
    assert.equal(windows.weekly!.valueLabel, '65 / 60k credits');
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

  test('surfaces subscription and allowance windows (allowance keyed by period, percent value)', async () => {
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
    // the usage value stays a percent — no key-name valueLabel.
    const allowWindow = result.usage!.windows.monthly;
    assert.ok(allowWindow);
    assert.equal(allowWindow!.usedPercent, 25);
    assert.equal(allowWindow!.valueLabel, undefined);
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
    assert.equal(window!.valueLabel, undefined);
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
    assert.equal(window!.valueLabel, undefined);
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

  test('marks blocked allowance as 100% with percent value', async () => {
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
    assert.equal(window!.valueLabel, undefined);
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
  test('teardown: restore fs', () => {
    const fsMock = fs as unknown as { existsSync: unknown; readFileSync: unknown };
    fsMock.existsSync = ORIGINAL_FS.existsSync;
    fsMock.readFileSync = ORIGINAL_FS.readFileSync;
  });
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

  test('teardown: restore fs', () => {
    const fsMock = fs as unknown as { existsSync: unknown; readFileSync: unknown };
    fsMock.existsSync = ORIGINAL_FS.existsSync;
    fsMock.readFileSync = ORIGINAL_FS.readFileSync;
  });
});

describe('Ollama Cloud quota validation and refresh', () => {
  const credential = { cookie: 'test-ollama-cookie' };
  const readCookie = () => credential.cookie;

  for (const { html, expected } of [
    { html: '<h1>Monthly usage</h1><p>$25.00 of $100.00</p>', expected: { monthly: { usedPercent: 25, valueLabel: '$25.00 / $100.00' } } },
    { html: 'Monthly usage $1,250.00 of $2,500.00', expected: { monthly: { usedPercent: 50, valueLabel: '$1,250.00 / $2,500.00' } } },
    { html: 'Session usage 12% Weekly usage 34% Premium 2 / 10', expected: { session: { usedPercent: 12 }, weekly: { usedPercent: 34 }, premium: { usedPercent: 20, valueLabel: '2 / 10' } } },
    { html: 'Monthly usage $0 of $100 Balance remaining $5.25 Add $5', expected: { monthly: { usedPercent: 0, valueLabel: '$0 / $100' }, credits_balance: { usedPercent: null, valueLabel: '$5.25' } } },
    { html: 'Monthly usage $0 of $100 Balance remaining $0.00 Add $5', expected: { monthly: { usedPercent: 0, valueLabel: '$0 / $100' } } },
    { html: 'Monthly usage $125 of $100 Add $5', expected: { monthly: { usedPercent: 100, valueLabel: '$125 / $100' } } },
  ]) {
    test(`accepts and displays ${html}`, async () => {
      let requests = 0;
      const fetchImpl = async (url: string, init: RequestInit) => {
        requests += 1;
        assert.equal(url, 'https://ollama.com/settings');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.method, 'GET');
        assert.equal(new Headers(init.headers).get('Cookie'), credential.cookie);
        assert.ok(init.signal instanceof AbortSignal);
        return new Response(html);
      };
      await validateCredential('ollama-cloud', credential, fetchImpl);
      const result = await fetchOllamaCloudQuota({ readCookie, fetchImpl });
      assert.equal(requests, 2);
      assert.equal(result.ok, true);
      assert.ok(result.usage);
      assert.deepEqual(Object.keys(result.usage.windows), Object.keys(expected));
      for (const [key, expectedWindow] of Object.entries(expected)) {
        const window: NonNullable<typeof result.usage>['windows'][string] = result.usage.windows[key];
        assert.ok(window);
        assert.equal(window.usedPercent, expectedWindow.usedPercent);
        if ('valueLabel' in expectedWindow) assert.equal(window.valueLabel, expectedWindow.valueLabel);
        assert.equal(window.resetAt, null);
      }
      assert.equal(JSON.stringify(result).includes(credential.cookie), false);
    });
  }

  for (const html of ['', '<h1>Monthly usage</h1>', 'Session usage', 'Session usage 1.2.3%', 'Weekly usage 1.2.3%', 'Add $5', 'Monthly usage $1.2.3 of $100', 'Balance remaining $1.2.3']) {
    test(`rejects unparseable HTML ${JSON.stringify(html)} in both consumers`, async () => {
      const fetchImpl = async () => new Response(html);
      await assert.rejects(validateCredential('ollama-cloud', credential, fetchImpl), /usage data could not be parsed/);
      const result = await fetchOllamaCloudQuota({ readCookie, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.usage, null);
      assert.equal(result.error, 'Ollama Cloud usage data could not be parsed');
    });
  }

  for (const status of [302, 307, 401, 403, 429, 500]) {
    test(`rejects HTTP ${status} in both consumers`, async () => {
      const fetchImpl = async () => new Response('Monthly usage $25 of $100', { status });
      await assert.rejects(validateCredential('ollama-cloud', credential, fetchImpl), /authentication failed/);
      const result = await fetchOllamaCloudQuota({ readCookie, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
      assert.equal(result.error, 'Ollama Cloud authentication failed');
    });
  }

  for (const failure of [new DOMException('Request timed out', 'TimeoutError'), new Error('Network unavailable')]) {
    test(`reports ${failure.message} in both consumers`, async () => {
      const fetchImpl = async () => { throw failure; };
      await assert.rejects(validateCredential('ollama-cloud', credential, fetchImpl), failure);
      const result = await fetchOllamaCloudQuota({ readCookie, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
      assert.equal(result.error, failure.message);
    });
  }

  test('does not request usage without a cookie', async () => {
    const result = await fetchOllamaCloudQuota({ readCookie: () => undefined, fetchImpl: async () => { assert.fail('Unexpected request'); } });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
  });

  test('reports response body failures in both consumers', async () => {
    const failure = new Error('Response body interrupted');
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    }));

    await assert.rejects(validateCredential('ollama-cloud', credential, fetchImpl), failure);
    const result = await fetchOllamaCloudQuota({ readCookie, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, failure.message);
    assert.deepEqual(credential, { cookie: 'test-ollama-cookie' });
  });
});

describe('Charm Hyper quota provider (VS Code parity)', () => {
  const readAuth = () => ({ hyper: { key: 'test-token' } });

  for (const { balance, credits, dollars } of [
    { balance: 100, credits: '100', dollars: '$5.00' },
    { balance: '50', credits: '50', dollars: '$2.50' },
    { balance: 25.5, credits: '25.50', dollars: '$1.28' },
    { balance: 0, credits: '0', dollars: '$0.00' },
    { balance: '0', credits: '0', dollars: '$0.00' },
  ]) {
    test(`formats balance ${JSON.stringify(balance)} without an untranslated unit`, async () => {
      const result = await fetchHyperQuota({ readAuth, fetchImpl: async () => Response.json({ balance }) });
      assert.equal(result.ok, true);
      assert.equal(result.providerId, 'hyper');
      assert.equal(result.configured, true);
      assert.ok(result.usage);
      assert.equal(result.usage.windows.credits?.valueLabel, credits);
      assert.equal(result.usage.windows.credits_balance?.valueLabel, dollars);
      for (const window of Object.values(result.usage.windows)) {
        assert.equal(window.usedPercent, null);
        assert.equal(window.remainingPercent, null);
        assert.equal(window.windowSeconds, null);
        assert.equal(window.resetAt, null);
        assert.equal(window.resetAfterSeconds, null);
      }
    });
  }

  for (const payload of [
    {}, null, [], { balance: '' }, { balance: ' \t ' }, { balance: 'NaN' },
    { balance: 'Infinity' }, { balance: null }, { balance: true }, { balance: [] },
    { balance: {} },
  ]) {
    test(`rejects invalid payload ${JSON.stringify(payload)} instead of showing zero`, async () => {
      const result = await fetchHyperQuota({ readAuth, fetchImpl: async () => Response.json(payload) });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.error, 'No quota data in response');
      assert.equal(result.usage, null);
    });
  }

  for (const [index, auth] of [
    { hyper: { key: 'test-token' } },
    { hyper: { token: 'test-token' } },
    { hyper: 'test-token' },
    { hyper: { key: '  ', token: 'test-token' } },
    { hyper: { key: 42, token: 'test-token' } },
  ].entries()) {
    test(`uses validated credential variant ${index} for the documented request`, async () => {
      let requests = 0;
      const result = await fetchHyperQuota({
        readAuth: () => auth,
        fetchImpl: async (url, options) => {
          requests += 1;
          assert.equal(url, 'https://hyper.charm.land/v1/credits');
          assert.equal(options.method, 'GET');
          assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer test-token');
          assert.ok(options.signal instanceof AbortSignal);
          return Response.json({ balance: 100 });
        },
      });
      assert.equal(requests, 1);
      assert.equal(result.ok, true);
      assert.equal(JSON.stringify(result).includes('test-token'), false);
    });
  }

  for (const [index, readInvalidAuth] of [
    () => ({}),
    () => ({ hyper: { key: '' } }),
    () => ({ hyper: { key: '  ' } }),
    () => ({ hyper: { key: 42 } }),
  ].entries()) {
    test(`does not request usage with missing or invalid credential variant ${index}`, async () => {
      let requests = 0;
      const result = await fetchHyperQuota({
        readAuth: readInvalidAuth,
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ balance: 100 });
        },
      });
      assert.equal(requests, 0);
      assert.equal(result.ok, false);
      assert.equal(result.configured, false);
      assert.equal(result.error, 'Not configured');
    });
  }

  for (const { status, error } of [
    { status: 401, error: 'Session expired — please re-authenticate with Charm Hyper' },
    { status: 403, error: 'Session expired — please re-authenticate with Charm Hyper' },
    { status: 429, error: 'API error: 429' },
    { status: 500, error: 'API error: 500' },
  ]) {
    test(`reports HTTP ${status} as a failure`, async () => {
      const result = await fetchHyperQuota({ readAuth, fetchImpl: async () => new Response(null, { status }) });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.error, error);
      assert.equal(result.usage, null);
    });
  }

  test('reports invalid JSON as a parse failure', async () => {
    const result = await fetchHyperQuota({ readAuth, fetchImpl: async () => new Response('{') });
    assert.equal(result.error, 'Invalid response from provider');
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
  });

  for (const { failure, message } of [
    { failure: new DOMException('Timed out', 'TimeoutError'), message: 'Request timed out' },
    { failure: new Error('Network unavailable'), message: 'Network unavailable' },
  ]) {
    test(`reports ${message}`, async () => {
      const result = await fetchHyperQuota({ readAuth, fetchImpl: async () => { throw failure; } });
      assert.equal(result.error, message);
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.usage, null);
    });
  }
});

describe('NanoGPT quota provider (VS Code parity)', () => {
  const run = async (payload: Parameters<typeof Response.json>[0]) => {
    stubFetchReturning(async () => Response.json(payload));
    return fetchQuotaForProvider('nano-gpt');
  };

  test('reads daily and weekly token quotas with millisecond reset times', async () => {
    const result = await run({
      state: 'active', limits: { dailyInputTokens: 1000, weeklyInputTokens: 10000 },
      dailyInputTokens: { used: 100, percentUsed: 0.1, resetAt: 1893542400000 },
      weeklyInputTokens: { used: 2500, percentUsed: 0.25, resetAt: 1893974400000 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows.daily?.usedPercent, 10);
    assert.equal(result.usage?.windows.daily?.resetAt, 1893542400000);
    assert.equal(result.usage?.windows.weekly?.usedPercent, 25);
    assert.equal(result.usage?.windows.weekly?.windowSeconds, 604800);
    assert.equal(result.usage?.windows.weekly?.resetAt, 1893974400000);
  });

  test('reads a weekly-only subscription and computes usage from its top-level limit', async () => {
    const result = await run({
      limits: { dailyInputTokens: null, weeklyInputTokens: 10000 },
      dailyInputTokens: null, weeklyInputTokens: { used: 2500 },
    });
    assert.equal(Object.keys(result.usage?.windows ?? {}).join(','), 'weekly');
    assert.equal(result.usage?.windows.weekly?.usedPercent, 25);
  });

  test('prefers current daily quotas over legacy fields and uses the token limit', async () => {
    const result = await run({
      limits: { dailyInputTokens: 1000 },
      dailyInputTokens: { used: 300 }, daily: { percentUsed: 0.9 },
    });
    assert.equal(result.usage?.windows.daily?.usedPercent, 30);
  });

  test('keeps unavailable quota reads unknown', async () => {
    const result = await run({
      limits: { dailyInputTokens: 1000, weeklyInputTokens: 10000 },
      dailyInputTokens: { used: null, percentUsed: null, resetAt: null, degraded: true },
      weeklyInputTokens: { used: null, percentUsed: null, resetAt: null, degraded: true },
    });
    assert.equal(result.usage?.windows.daily?.usedPercent, null);
    assert.equal(result.usage?.windows.weekly?.usedPercent, null);
    assert.equal(result.usage?.windows.weekly?.remainingPercent, null);
  });

  test('preserves zero and clamps exhausted quotas', async () => {
    const result = await run({
      dailyInputTokens: { percentUsed: 0 }, weeklyInputTokens: { percentUsed: 1.1 },
    });
    assert.equal(result.usage?.windows.daily?.usedPercent, 0);
    assert.equal(result.usage?.windows.weekly?.usedPercent, 100);
  });

  test('preserves legacy daily and monthly response support', async () => {
    const result = await run({
      state: 'grace', period: { currentPeriodEnd: 1893974400000 },
      daily: { percentUsed: 0.4 }, monthly: { used: 50, limit: 100 },
    });
    assert.equal(result.usage?.windows.daily?.usedPercent, 40);
    assert.equal(result.usage?.windows.monthly?.usedPercent, 50);
    assert.equal(result.usage?.windows.monthly?.resetAt, 1893974400000);
    assert.equal(result.usage?.windows.daily?.valueLabel, '(grace)');
  });

  test('does not invent quotas when the account has none', async () => {
    const result = await run({ active: false, dailyInputTokens: null, weeklyInputTokens: null });
    assert.equal(result.ok, true);
    assert.equal(Object.keys(result.usage?.windows ?? {}).length, 0);
  });

  test('reports HTTP failures rather than empty success', async () => {
    stubFetchReturning(async () => new Response(null, { status: 401 }));
    const result = await fetchQuotaForProvider('nano-gpt');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'API error: 401');
  });
  test('does not revive a legacy daily cap when the current cap is null', async () => {
    const result = await run({ dailyInputTokens: null, daily: { percentUsed: 0.9 } });
    assert.equal(Object.keys(result.usage?.windows ?? {}).length, 0);
  });

  test('rejects malformed quota responses instead of reporting empty success', async () => {
    const result = await run({ weeklyInputTokens: 'invalid' });
    assert.equal(result.ok, false);
  });

});
