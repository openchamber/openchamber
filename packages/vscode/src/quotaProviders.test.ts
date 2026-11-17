import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialEntry } from '@opencode/client';

import { configureOpenCodeCredentials } from './opencodeAuth';

const previousQuotaDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
const temporaryQuotaDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-quota-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryQuotaDataDirectory;
// Credentials come from the running OpenCode; serve a fixed list so the
// providers treat themselves as configured and go straight to fetch.
const key = (integrationID: string): CredentialEntry => ({ id: `cred_${integrationID}`, integrationID, label: 'default', active: true, value: { type: 'key', key: 'test-token' } });
const oauth = (integrationID: string, metadata?: { enterpriseUrl?: string }): CredentialEntry => ({
  id: `cred_${integrationID}`,
  integrationID,
  label: 'default',
  active: true,
  value: { type: 'oauth', methodID: 'test', access: 'test-token', refresh: 'test-refresh', expires: 0, ...(metadata ? { metadata } : undefined) },
});
// The Console sign-in is an `opencode` OAuth credential carrying the Console
// server and selected organization, not an `opencode-go` service key.
const consoleOAuth = (overrides: { server?: string; orgID?: string; expires?: number } = {}): CredentialEntry => ({
  id: 'cred_opencode',
  integrationID: 'opencode',
  label: 'default',
  active: true,
  value: {
    type: 'oauth',
    methodID: 'test',
    access: 'console-token',
    refresh: 'console-refresh',
    expires: Date.now() + 3_600_000,
    metadata: { server: 'https://opencode.ai/console', orgID: 'org_TESTORG123', ...overrides },
  },
});
let copilotEnterpriseUrl: string | undefined;
const baseCredentialList = (): CredentialEntry[] => [
  oauth('openai'),
  key('cline-pass'),
  key('neuralwatt'),
  key('opencode-go'),
  key('openrouter'),
  key('zai-coding-plan'),
  key('zhipuai-coding-plan'),
  key('deepseek'),
  key('deepinfra'),
  key('hyper'),
  key('mistral'),
  key('command-code'),
  key('nano-gpt'),
  key('wafer'),
  oauth('github-copilot', copilotEnterpriseUrl ? { enterpriseUrl: copilotEnterpriseUrl } : undefined),
  oauth('anthropic'),
];
configureOpenCodeCredentials({ list: async () => baseCredentialList() });

import { activateQuotaGiftReset, fetchClaudeQuota, fetchClinePassQuota, fetchCodexQuota, fetchCopilotQuota, fetchDeepinfraQuota, fetchDeepseekQuota, fetchHyperQuota, fetchKiloQuota, fetchKimiQuota, fetchMetaQuota, fetchMistralQuota, fetchCommandCodeQuota, fetchOpenDesignQuota, fetchNanoGptQuota, fetchNeuralwattQuota, fetchOllamaCloudQuota, fetchOpenRouterQuota, fetchZaiQuota, fetchZhipuaiCodingPlanQuota, listConfiguredQuotaProviders, resetMetaQuotaCache, fetchQuotaForProvider, fetchXaiQuota, fetchZenmuxQuota, normalizeTimestamp, toTimestamp } from './quotaProviders';

type MockResponseInit = { ok?: boolean; status?: number };

after(() => {
  if (previousQuotaDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousQuotaDataDirectory;
  fs.rmSync(temporaryQuotaDataDirectory, { recursive: true, force: true });
});

// A real Response, not a json()-only stand-in: quota modules that read the
// body through the bounded reader need genuine headers/body streams, and a
// faithful mock keeps every provider honest about the Fetch surface it uses.
const mockResponse = (body: unknown, init: MockResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

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
  copilotEnterpriseUrl = undefined;
});

const stubFetchReturning = (resolver: (url: string, init?: RequestInit) => Promise<unknown>): void => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    resolver(String(input), init)) as typeof fetch;
};

const stubFetchFailing = (json: () => Promise<unknown>, init: MockResponseInit): void => {
  globalThis.fetch = (async () => ({ json, ...init }) as unknown as Response) as typeof fetch;
};

describe('quota timestamp helpers', () => {
  test('toTimestamp rejects non-finite numeric inputs', () => {
    assert.equal(toTimestamp(Infinity), null);
    assert.equal(toTimestamp(-Infinity), null);
    assert.equal(toTimestamp(NaN), null);
  });

  test('toTimestamp preserves finite numbers and date-string parsing', () => {
    assert.equal(toTimestamp(1_700_000_000), 1_700_000_000_000);
    assert.equal(toTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(toTimestamp('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
    assert.equal(toTimestamp('garbage'), null);
  });

  test('normalizeTimestamp rejects non-finite numeric inputs', () => {
    assert.equal(normalizeTimestamp(Infinity), null);
    assert.equal(normalizeTimestamp(-Infinity), null);
    assert.equal(normalizeTimestamp(NaN), null);
  });

  test('normalizeTimestamp preserves finite scaling and rejects non-numeric inputs', () => {
    assert.equal(normalizeTimestamp(1_700_000_000), 1_700_000_000_000);
    assert.equal(normalizeTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(normalizeTimestamp('2023-11-14T22:13:20.000Z'), null);
    assert.equal(normalizeTimestamp(null), null);
  });
});

test('dispatches Charm Hyper through the generic quota API', async () => {
  stubFetchReturning(async () => Response.json({ balance: 100 }));
  const result = await fetchQuotaForProvider('hyper');
  assert.equal(result.ok, true);
  assert.equal(result.usage?.windows.credits?.valueLabel, '100');
});

describe('OpenCode Go quota provider (VS Code parity)', () => {
  test('uses the opencode-go key stored in OpenCode', async () => {
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
    assert.equal((request?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer test-token');
    assert.equal((request?.headers as Record<string, string> | undefined)?.['x-opencode-session'], 'openchamber-usage');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.equal(result.planLabel, undefined);
    assert.throws(() => fs.statSync(legacyPath));
  });

  // OpenCode binds OpenCode Go to the Console's `opencode` integration when the
  // key's workspace has Go, and Providers lists that key under OpenCode Go.
  describe('with an API key on the Console integration only', () => {
    beforeEach(() => {
      configureOpenCodeCredentials({ list: async () => [key('opencode')] });
    });

    afterEach(() => {
      configureOpenCodeCredentials({ list: async () => baseCredentialList() });
    });

    test('reads the usage with that key', async () => {
      let request: RequestInit | undefined;
      stubFetchReturning(async (_url, init) => {
        request = init;
        return mockResponse({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } });
      });

      const result = await fetchQuotaForProvider('opencode-go');

      assert.equal(result.ok, true);
      assert.equal(new Headers(request?.headers).get('Authorization'), 'Bearer test-token');
      assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    });

    test('reports an absent subscription on a 403', async () => {
      stubFetchReturning(async () => mockResponse({}, { ok: false, status: 403 }));
      const result = await fetchQuotaForProvider('opencode-go');
      assert.equal(result.configured, true);
      assert.equal(result.error, 'No active OpenCode Go subscription on the selected Console account');
    });
  });
});

describe('OpenCode Go quota provider — Console OAuth (VS Code parity)', () => {
  beforeEach(() => {
    configureOpenCodeCredentials({ list: async () => [consoleOAuth()] });
  });

  afterEach(() => {
    configureOpenCodeCredentials({ list: async () => baseCredentialList() });
  });

  test('uses the Console status endpoint and maps meters to windows', async () => {
    let requestedUrl = '';
    let request: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === 'https://opencode.ai/console/api/billing/status') {
        return mockResponse({ availableMicroCents: '1234000000' });
      }
      requestedUrl = url;
      request = init;
      return mockResponse({
        product: 'go',
        access: { meters: {
          fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000000000', usedMicroCents: '250000000' },
          week: { resetsAt: '2026-08-19T12:00:00.000Z', limitMicroCents: '2000000000', usedMicroCents: '800000000' },
          month: { resetsAt: '2026-09-01T00:00:00.000Z', limitMicroCents: '6000000000', usedMicroCents: '3000000000' },
        } },
      });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(requestedUrl, 'https://opencode.ai/console/api/go/status');
    assert.equal((request?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer console-token');
    assert.equal((request?.headers as Record<string, string> | undefined)?.['x-org-id'], 'org_TESTORG123');
    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.equal(result.usage!.windows.weekly!.usedPercent, 40);
    assert.equal(result.usage!.windows.monthly!.usedPercent, 50);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$12.34');
    assert.equal(result.usage!.windows.credits_balance!.usedPercent, null);
    assert.equal(result.planLabel, 'go');
  });

  test('accepts a wrk_ workspace id from the Console sign-in', async () => {
    const orgID = 'wrk_01JBW7QK3E8V2Y5M9R4T6A8C0D';
    configureOpenCodeCredentials({ list: async () => [consoleOAuth({ orgID })] });
    let request: RequestInit | undefined;
    // SAFETY: the stub answers the same two Console URLs fetch is given here.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === 'https://opencode.ai/console/api/billing/status') {
        return mockResponse({ availableMicroCents: '1200000000' });
      }
      request = init;
      return mockResponse({
        product: 'go',
        access: { meters: {
          fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000000000', usedMicroCents: '250000000' },
        } },
      });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(new Headers(request?.headers).get('x-org-id'), orgID);
    assert.equal(result.ok, true);
  });

  test('keeps the meters when the billing balance cannot be read', async () => {
    stubFetchReturning(async (url) => (url === 'https://opencode.ai/console/api/billing/status'
      ? mockResponse({}, { ok: false, status: 500 })
      : mockResponse({
        product: 'go',
        access: { meters: {
          fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents: '250' },
        } },
      })));

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['5h']);
    assert.equal(result.usage!.windows.credits_balance, undefined);
  });

  test('supports Go Plus and keeps usable windows when another meter is malformed', async () => {
    globalThis.fetch = (async () => mockResponse({
      product: 'go-plus',
      access: { meters: {
        fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '0', usedMicroCents: '10' },
        week: { resetsAt: '2026-08-19T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents: '250' },
      } },
    })) as typeof fetch;

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['weekly']);
    assert.equal(result.usage!.windows.weekly!.usedPercent, 25);
    assert.equal(result.planLabel, 'go-plus');
  });

  test('distinguishes an absent subscription from a temporary failure', async () => {
    globalThis.fetch = (async () => mockResponse({ product: 'free', access: { meters: {} } })) as typeof fetch;
    const absent = await fetchQuotaForProvider('opencode-go');
    assert.equal(absent.configured, true);
    assert.match(absent.error ?? '', /subscription/i);

    globalThis.fetch = (async () => mockResponse({}, { ok: false, status: 502 })) as typeof fetch;
    const failed = await fetchQuotaForProvider('opencode-go');
    assert.equal(failed.configured, true);
    assert.match(failed.error ?? '', /HTTP 502/);
  });

  test('matches web errors for a missing product and normalizes epoch-second resets', async () => {
    stubFetchReturning(async () => mockResponse({ access: { meters: {} } }));
    const absent = await fetchQuotaForProvider('opencode-go');
    assert.equal(absent.configured, true);
    assert.match(absent.error ?? '', /subscription/i);

    stubFetchReturning(async () => mockResponse({
      product: 'go',
      access: { meters: {
        fiveHour: { resetsAt: 1_786_000_000, limitMicroCents: 1000, usedMicroCents: 250 },
      } },
    }));
    const usage = await fetchQuotaForProvider('opencode-go');
    assert.equal(usage.ok, true);
    assert.equal(usage.usage!.windows['5h']!.resetAt, 1_786_000_000_000);
  });

  test('falls back to the API key when the sign-in is not a Console sign-in', async () => {
    configureOpenCodeCredentials({ list: async () => [consoleOAuth({ server: 'https://example.com/console' }), key('opencode-go')] });
    let requestedUrl = '';
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return mockResponse({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } });
    }) as typeof fetch;

    const result = await fetchQuotaForProvider('opencode-go');

    assert.equal(requestedUrl, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
  });

  test('falls back to the API key when the Console read fails', async () => {
    configureOpenCodeCredentials({ list: async () => [consoleOAuth(), key('opencode-go')] });
    const requestedUrls: string[] = [];
    stubFetchReturning(async (url) => {
      requestedUrls.push(url);
      return url === 'https://opencode.ai/console/api/go/status'
        ? mockResponse({ product: 'zen', access: { meters: {} } })
        : mockResponse({ usage: { rolling: { percent: 10, resetsAt: '2026-08-12T12:00:00.000Z' } } });
    });

    const result = await fetchQuotaForProvider('opencode-go');

    // The billing read starts alongside the Go status; its result is dropped
    // when the Console read fails.
    assert.deepEqual(requestedUrls, ['https://opencode.ai/console/api/billing/status', 'https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage']);
    assert.equal(result.usage!.windows.credits_balance, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows['5h']!.usedPercent, 10);
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

  const withStubbedConfigFile = async (configJson: string, run: () => Promise<void>): Promise<void> => {
    // SAFETY: the reassignments widen the bound fs functions to the signatures
    // the config reader actually calls.
    const configurableFs = fs as {
      existsSync: (filePath: fs.PathLike) => boolean;
      readFileSync: (filePath: fs.PathOrFileDescriptor, options?: BufferEncoding) => string;
      openSync: (filePath: fs.PathLike, flags?: string | number) => number;
      fstatSync: (fd: number) => { isFile: () => boolean; size: number };
      readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => number;
      closeSync: (fd: number) => void;
    };
    const realExists = configurableFs.existsSync;
    const realRead = configurableFs.readFileSync;
    const realOpen = configurableFs.openSync;
    const realFstat = configurableFs.fstatSync;
    const realReadSync = configurableFs.readSync;
    const realClose = configurableFs.closeSync;
    // The config loader gates on existsSync before reading. Without this stub
    // a machine that has no global opencode.json (a clean CI runner) never
    // reaches the stubbed read, so the provider falls back to its default
    // endpoint and the configured-baseURL assertions fail there while passing
    // on any developer machine that happens to have a config.
    configurableFs.existsSync = (filePath: fs.PathLike): boolean => (
      String(filePath).includes('opencode.json') ? true : realExists(filePath)
    );
    configurableFs.readFileSync = (filePath: fs.PathOrFileDescriptor, options?: BufferEncoding): string => (
      String(filePath).includes('opencode.json') ? configJson : realRead(filePath, options)
    );
    // The loader reads config files through the capped reader
    // (openSync/fstatSync/readSync/closeSync in opencodeConfig.ts), not
    // readFileSync, so the stubbed content must be served there too -
    // otherwise the read hits the real global config (or ENOENT where none
    // exists) and the configured baseURL never reaches the provider.
    const stubbedFiles = new Map<number, { content: Buffer; offset: number }>();
    let nextStubbedFd = 10_000;
    configurableFs.openSync = (filePath: fs.PathLike, flags?: string | number): number => {
      if (!String(filePath).includes('opencode.json')) return realOpen(filePath, flags);
      const fd = nextStubbedFd;
      nextStubbedFd += 1;
      stubbedFiles.set(fd, { content: Buffer.from(configJson, 'utf8'), offset: 0 });
      return fd;
    };
    configurableFs.fstatSync = (fd: number) => {
      const stubbed = stubbedFiles.get(fd);
      return stubbed ? { isFile: () => true, size: stubbed.content.length } : realFstat(fd);
    };
    configurableFs.readSync = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null): number => {
      const stubbed = stubbedFiles.get(fd);
      if (!stubbed) return realReadSync(fd, buffer, offset, length, position);
      const start = position ?? stubbed.offset;
      // SAFETY: the capped reader passes the Buffer it allocated for this
      // read; the cast only restores that concrete type for Buffer.copy.
      const bytesRead = stubbed.content.copy(buffer as Buffer, offset, start, start + length);
      stubbed.offset = start + bytesRead;
      return bytesRead;
    };
    configurableFs.closeSync = (fd: number): void => {
      if (!stubbedFiles.delete(fd)) realClose(fd);
    };
    try {
      await run();
    } finally {
      configurableFs.readFileSync = realRead;
      configurableFs.existsSync = realExists;
      configurableFs.openSync = realOpen;
      configurableFs.fstatSync = realFstat;
      configurableFs.readSync = realReadSync;
      configurableFs.closeSync = realClose;
    }
  };

  const stubFetchCapturingUrl = (payload: Response, requested: { url: string }): void => {
    // SAFETY: per-test fetch stub; the cast only fits the capturing closure
    // into the global fetch slot for the duration of one test.
    globalThis.fetch = (async (url: string) => {
      requested.url = url;
      return payload;
    }) as typeof fetch;
  };

  test('reads the key endpoint from the configured v2 provider baseURL', async () => {
    const requested = { url: '' };
    await withStubbedConfigFile(
      JSON.stringify({
        providers: {
          openrouter: { settings: { baseURL: 'https://gateway.example.com/v1' } },
        },
      }),
      async () => {
        stubFetchCapturingUrl(mockResponse(documentedPayload), requested);
        await fetchQuotaForProvider('openrouter');
      },
    );

    assert.equal(requested.url, 'https://gateway.example.com/v1/key');
  });

  test('reads the key endpoint from the legacy provider options baseURL', async () => {
    const requested = { url: '' };
    await withStubbedConfigFile(
      JSON.stringify({
        provider: {
          openrouter: { options: { baseURL: 'https://legacy.example.com/v1' } },
        },
      }),
      async () => {
        stubFetchCapturingUrl(mockResponse(documentedPayload), requested);
        await fetchQuotaForProvider('openrouter');
      },
    );

    assert.equal(requested.url, 'https://legacy.example.com/v1/key');
  });

  test('reads the key endpoint from the legacy provider api field', async () => {
    const requested = { url: '' };
    await withStubbedConfigFile(
      JSON.stringify({
        provider: {
          openrouter: { api: 'https://legacy-api.example.com/v1' },
        },
      }),
      async () => {
        stubFetchCapturingUrl(mockResponse(documentedPayload), requested);
        await fetchQuotaForProvider('openrouter');
      },
    );

    assert.equal(requested.url, 'https://legacy-api.example.com/v1/key');
  });

  test('strips trailing slashes from the configured baseURL', async () => {
    const requested = { url: '' };
    await withStubbedConfigFile(
      JSON.stringify({
        providers: {
          openrouter: { settings: { baseURL: 'https://gateway.example.com/v1/' } },
        },
      }),
      async () => {
        stubFetchCapturingUrl(mockResponse(documentedPayload), requested);
        await fetchQuotaForProvider('openrouter');
      },
    );

    assert.equal(requested.url, 'https://gateway.example.com/v1/key');
  });

  test('keeps the default key endpoint when the config cannot be parsed', async () => {
    const requested = { url: '' };
    await withStubbedConfigFile('{ not json', async () => {
      stubFetchCapturingUrl(mockResponse(documentedPayload), requested);
      await fetchQuotaForProvider('openrouter');
    });

    assert.equal(requested.url, 'https://openrouter.ai/api/v1/key');
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

  test('maps a lifetime cap to a key_limit window without reset metadata', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: null, usage_monthly: 5 },
    })));

    const result = await fetchQuotaForProvider('openrouter');
    const window = result.usage!.windows.key_limit;

    assert.ok(window);
    assert.equal(window!.windowSeconds, null);
    assert.equal(window!.resetAt, null);
  });

  test('maps an unrecognized reset period to a key_limit window', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'yearly', usage_monthly: 5 },
    })));

    const result = await fetchQuotaForProvider('openrouter');

    assert.ok(result.usage!.windows.key_limit);
    assert.equal(result.usage!.windows.key_limit!.windowSeconds, null);
    assert.equal(result.usage!.windows.key_limit!.resetAt, null);
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

  for (const [percentUsed, expected] of [[150, 100], ['150', 100], [-20, 0], ['-20', 0]] as const) {
    test(`clamps out-of-range percentage ${JSON.stringify(percentUsed)} to ${expected}`, async () => {
      const result = await fetchClinePassQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [{ type: 'weekly', percentUsed }] } }) });
      assert.equal(result.ok, true);
      assert.equal(result.usage?.windows.weekly?.usedPercent, expected);
      assert.equal(result.usage?.windows.weekly?.remainingPercent, 100 - expected);
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
  for (const { balance, unlimited, expected } of [
    { balance: 62500, unlimited: false, expected: '62500' },
    { balance: '62500.00', unlimited: false, expected: '62500' },
    { balance: 12.3456, unlimited: false, expected: '12.3456' },
    { balance: '12.3456', unlimited: false, expected: '12.3456' },
    { balance: 0, unlimited: false, expected: '0' },
    { balance: null, unlimited: true, expected: 'Unlimited' },
    { balance: 62500, unlimited: true, expected: 'Unlimited' },
    { balance: null, unlimited: false, expected: undefined },
    { balance: 'invalid', unlimited: false, expected: undefined },
  ]) {
    test(`displays credit balance ${balance} with unlimited=${unlimited} as ${expected}`, async () => {
      globalThis.fetch = async () => Response.json({ credits: { balance, unlimited } });

      const result = await fetchQuotaForProvider('codex');

      assert.equal(result.ok, true);
      assert.ok(result.usage?.windows.credits_balance);
      assert.equal(result.usage.windows.credits_balance.valueLabel, expected);
      assert.equal(result.usage.windows.credits_balance.usedPercent, null);
    });
  }

  test('tells an access-enforcement 401 apart from an expired session', async () => {
    globalThis.fetch = async () => Response.json(
      { error: { type: 'rejected_by_access_enforcement', code: 'no_matching_rule' } },
      { status: 401 },
    );
    const refused = await fetchQuotaForProvider('codex');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');

    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const expired = await fetchQuotaForProvider('codex');
    assert.equal(expired.error, 'Session expired \u2014 please re-authenticate with OpenAI');
  });

  test('falls back to an instance credential when the bare integration holds none', async () => {
    const configPath = path.join(os.tmpdir(), `openchamber-codex-instance-${process.pid}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      provider: { 'openai.main': { instanceOf: 'openai', name: 'OpenAI Main (drewrypope)' } },
    }));
    process.env.OPENCODE_CONFIG = configPath;
    configureOpenCodeCredentials({ list: async () => [oauth('openai.main')] });
    try {
      globalThis.fetch = async () => Response.json({
        rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 1793513510 } },
      });

      const result = await fetchQuotaForProvider('codex');

      assert.equal(result.ok, true);
      assert.equal(result.usage?.windows.weekly.usedPercent, 8);
    } finally {
      delete process.env.OPENCODE_CONFIG;
      fs.rmSync(configPath, { force: true });
      configureOpenCodeCredentials({ list: async () => baseCredentialList() });
    }
  });

  test('omits the balance window when credits are absent', async () => {
    globalThis.fetch = async () => Response.json({ rate_limit: null });

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, true);
    assert.ok(result.usage);
    assert.equal(result.usage.windows.credits_balance, undefined);
  });

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
    // The request goes out once the credential read settles.
    while (!resolveResponse) await new Promise((resolve) => setImmediate(resolve));
    resolveResponse(mockResponse({ rate_limit: null }));

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

  // The usage endpoint forwards its own percentages, and they can fall outside
  // 0-100 on an exhausted overage or a spend control. Primary, secondary and
  // spend control all clamp both bounds, and an absent value stays null.
  for (const { label, usedPercent, expected, expectedRemaining } of [
    { label: 'clamps above 100', usedPercent: 150, expected: 100, expectedRemaining: 0 },
    { label: 'clamps below 0', usedPercent: -20, expected: 0, expectedRemaining: 100 },
    { label: 'clamps a far overage', usedPercent: 200, expected: 100, expectedRemaining: 0 },
    { label: 'keeps an in-range value', usedPercent: 42, expected: 42, expectedRemaining: 58 },
    { label: 'keeps a missing value null', usedPercent: null, expected: null, expectedRemaining: null },
  ]) {
    test(`${label} on every Codex window`, async () => {
      stubFetchReturning(() => Promise.resolve(mockResponse({
        rate_limit: {
          primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: usedPercent, limit_window_seconds: 604_800, reset_at: 1_700_000_000 },
        },
        spend_control: {
          individual_limit: { limit: '7500', used: '100', used_percent: usedPercent },
        },
      })));

      const result = await fetchQuotaForProvider('codex');

      assert.equal(result.ok, true);
      for (const [name, window] of Object.entries(result.usage!.windows)) {
        if (name === 'credits') continue;
        assert.equal(window.usedPercent, expected, `${name} usedPercent`);
        assert.equal(window.remainingPercent, expectedRemaining, `${name} remainingPercent`);
      }
      assert.equal(result.usage!.windows.credits!.usedPercent, expected);
      assert.equal(result.usage!.windows.credits!.remainingPercent, expectedRemaining);
    });
  }

  test('fails the provider result for an over-cap response body (#1282)', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      rate_limit: null,
      pad: 'x'.repeat(1024 * 1024),
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /exceeded the 1 MiB limit/);
  });

  test('stops a streamed over-cap response body instead of buffering it whole (#1282)', async () => {
    const body = JSON.stringify({ rate_limit: null, pad: 'x'.repeat(2 * 1024 * 1024) });
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.subarray(offset, offset + 8192);
        offset += chunk.byteLength;
        pulled = offset;
        controller.enqueue(chunk);
      },
    });
    stubFetchReturning(() => Promise.resolve(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /exceeded the 1 MiB limit/);
    assert.ok(pulled < body.length, 'the reader stopped before the whole body was pulled');
  });

  test('leaves a fractional in-range spend percent unrounded', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      rate_limit: null,
      spend_control: { individual_limit: { limit: '7500', used: '1', used_percent: 36.5 } },
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.usage!.windows.credits!.usedPercent, 36.5);
  });
});

describe('GitHub Copilot quota provider (VS Code parity)', () => {
  test('exposes only premium interactions as the primary usage window', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        chat: { entitlement: 100, remaining: 80 },
        completions: { entitlement: 1000, remaining: 900 },
        premium_interactions: { entitlement: 60000, remaining: 39078, percent_remaining: 34.9 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['premium_interactions']);
    assert.ok(Math.abs(result.usage!.windows.premium_interactions!.usedPercent! - 34.87) < 1e-9);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '20,922 / 60,000 used');
  });

  test('uses the enterprise Copilot API from the active OpenCode login', async () => {
    copilotEnterpriseUrl = 'https://ghe.example.com/';
    let requestedUrl = '';
    stubFetchReturning(async (url) => {
      requestedUrl = url;
      return mockResponse({ quota_snapshots: { premium_interactions: { entitlement: 20_000, remaining: 12_000 } } });
    });

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.equal(requestedUrl, 'https://api.ghe.example.com/copilot_internal/user');
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '8,000 / 20,000 used');
  });

  for (const [label, enterpriseUrl] of [
    ['credentials in the authority', 'https://user@ghe.example.com/'],
    ['an explicit port', 'https://ghe.example.com:8443/'],
    ['a query string', 'https://ghe.example.com/?next=evil.example.com'],
    ['a non-HTTP scheme', 'file://ghe.example.com/'],
    ['a host that is not a DNS name', 'ghe_example.com'],
  ] as const) {
    test(`refuses ${label} instead of requesting a host derived from it`, async () => {
      copilotEnterpriseUrl = enterpriseUrl;
      let requested = false;
      stubFetchReturning(async () => {
        requested = true;
        return mockResponse({});
      });

      const result = await fetchQuotaForProvider('github-copilot');

      assert.equal(result.ok, false);
      assert.equal(result.error, 'Invalid GitHub Copilot Enterprise URL');
      assert.equal(requested, false);
    });
  }

  test('does not send the credential when enterprise URL metadata is malformed', async () => {
    copilotEnterpriseUrl = 'https://ghe.example.com/copilot';
    let requested = false;
    stubFetchReturning(async () => {
      requested = true;
      return mockResponse({});
    });

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid GitHub Copilot Enterprise URL');
    assert.equal(requested, false);
  });

  test('derives the credit label from the same used axis as VS Code on fractional credits', async () => {
    // The live Business-plan shape: `remaining` (39078) is the integer twin of
    // `quota_remaining` (39078.5). GitHub's own Copilot panel reports
    // 20,921.5 / 60,000 used for this snapshot, and the old label read
    // "39078 / 60000 left".
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-11-01T00:00:00.000Z',
      quota_snapshots: {
        premium_interactions: {
          overage_count: 0,
          overage_permitted: true,
          percent_remaining: 65.1,
          quota_remaining: 39078.5,
          unlimited: false,
          credits_used: 20910,
          remaining: 39078,
          entitlement: 60000,
        },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.usage!.windows.premium_interactions!.usedPercent! - 34.86916666666666) < 1e-9);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '20,921.5 / 60,000 used');
  });

  test('keeps the fractional credit rather than rounding it away', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 100, quota_remaining: 65.27 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '34.7 / 100 used');
  });

  test('falls back to the integer remaining when quota_remaining is absent', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 1000, remaining: 250 },
      },
    })));

    const result = await fetchQuotaForProvider('github-copilot');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.premium_interactions!.valueLabel, '750 / 1,000 used');
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

  test('clamps limits and spend percentages while preserving missing values', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      limits: [
        { kind: 'session', percent: 150 },
        { kind: 'weekly_all', percent: -20 },
        { kind: 'weekly_scoped', percent: 42, scope: { model: { display_name: 'Sonnet' } } },
        { kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } } },
      ],
      spend: { enabled: true, percent: 200 },
    })));

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.usage?.windows['5h']?.usedPercent, 100);
    assert.equal(result.usage?.windows['7d']?.usedPercent, 0);
    assert.equal(result.usage?.windows.extra_usage?.usedPercent, 100);
    assert.equal(result.usage?.models?.Sonnet?.windows['7d']?.usedPercent, 42);
    assert.equal(result.usage?.models?.Opus?.windows['7d']?.usedPercent, null);
  });

  test('clamps legacy utilization and keeps missing percentages null', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      five_hour: { utilization: 150 },
      seven_day: { utilization: -20 },
    })));

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.usage?.windows['5h']?.usedPercent, 100);
    assert.equal(result.usage?.windows['7d']?.usedPercent, 0);

    stubFetchReturning(() => Promise.resolve(mockResponse({
      five_hour: {},
      seven_day: {},
      spend: { enabled: true },
    })));

    const missing = await fetchQuotaForProvider('claude');

    assert.equal(missing.usage?.windows['5h']?.usedPercent, null);
    assert.equal(missing.usage?.windows['7d']?.usedPercent, null);
    assert.equal(missing.usage?.windows.extra_usage?.usedPercent, null);
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

  test('clamps out-of-range percentages to [0, 100]', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 150 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: -20 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 150 },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.usedPercent, 100);
    assert.equal(windows['5h']!.remainingPercent, 0);
    assert.equal(windows.weekly!.usedPercent, 0);
    assert.equal(windows.weekly!.remainingPercent, 100);
    assert.equal(windows['MCP Tools']!.usedPercent, 100);
  });

  test('reports non-finite percentages as unknown instead of clamping them', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: Number.POSITIVE_INFINITY },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: Number.NaN },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: Number.NEGATIVE_INFINITY },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.usedPercent, null);
    assert.equal(windows['5h']!.remainingPercent, null);
    assert.equal(windows.weekly!.usedPercent, null);
    assert.equal(windows.weekly!.remainingPercent, null);
    assert.equal(windows['MCP Tools']!.usedPercent, null);
    assert.equal(windows['MCP Tools']!.remainingPercent, null);
  });

  test('reports a z.ai business failure sent inside an HTTP 200 body', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ code: 1001, msg: 'Token expired', success: false })));

    const result = await fetchQuotaForProvider('zai-coding-plan');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Token expired');
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

  test('attaches the nearest available gift reset to the matching windows', async () => {
    const responses = [
      mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: 1785659659993 },
            { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, nextResetTime: 1787128459979 },
          ],
        },
      }),
      mockResponse({
        code: 200,
        success: true,
        data: {
          targetType: 'PERSONAL',
          fiveHourResets: [
            { recordId: 387233, expireTime: '2099-06-15 12:30:00', available: false },
            { recordId: 111111, expireTime: '2020-01-01 00:00:00', available: true },
            { recordId: 666002, expireTime: 'not-a-date', available: true },
            { recordId: 462029, expireTime: '2099-09-11 06:01:35', available: true },
            { recordId: 555501, expireTime: '2099-06-15 12:30:00', available: true },
          ],
          weekResets: [
            { recordId: 777003, expireTime: '2099-03-01 08:00:00', available: true },
          ],
        },
      }),
    ];
    let requestCount = 0;
    stubFetchReturning(async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    });

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.deepEqual(windows['5h']!.giftReset, {
      recordId: 555501,
      expireAt: Date.parse('2099-06-15T12:30:00+08:00'),
    });
    assert.deepEqual(windows.weekly!.giftReset, {
      recordId: 777003,
      expireAt: Date.parse('2099-03-01T08:00:00+08:00'),
    });
    assert.equal(windows['MCP Tools']!.giftReset, undefined);
  });

  test('keeps the quota result ok when the gift reset list request fails', async () => {
    const responses = [
      mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
          ],
        },
      }),
      mockResponse({}, { ok: false, status: 500 }),
    ];
    let requestCount = 0;
    stubFetchReturning(async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    });

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.usedPercent, 42);
    assert.equal(windows['5h']!.giftReset, undefined);
  });

  test('attaches no gift reset while only expired resets remain', async () => {
    const responses = [
      mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 10 },
          ],
        },
      }),
      mockResponse({
        code: 200,
        success: true,
        data: {
          fiveHourResets: [
            { recordId: 111111, expireTime: '2020-01-01 00:00:00', available: true },
            { recordId: 999999, expireTime: '2099-01-01 00:00:00', available: false },
            { recordId: 222222, expireTime: '2026-01-01 00:00:00', available: true },
          ],
          weekResets: [],
        },
      }),
    ];
    let requestCount = 0;
    stubFetchReturning(async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    });

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.giftReset, undefined);
    assert.equal(windows.weekly!.giftReset, undefined);
  });

  test('attaches no gift reset for an expired unavailable record', async () => {
    const responses = [
      mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
          ],
        },
      }),
      mockResponse({
        code: 200,
        success: true,
        data: {
          // z.ai flips `available` to false once a record expires.
          fiveHourResets: [
            { recordId: 387233, expireTime: '2026-09-04 22:25:19', available: false },
          ],
          weekResets: [],
        },
      }),
    ];
    let requestCount = 0;
    stubFetchReturning(async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    });

    const result = await fetchQuotaForProvider('zai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(windows['5h']!.giftReset, undefined);
  });
});

describe('Z.ai gift reset activation (VS Code parity)', () => {
  test('rejects providers without gift reset support', async () => {
    await assert.rejects(
      activateQuotaGiftReset('ollama-cloud', { recordId: 1, resetType: 'FIVE_HOUR' }),
      /Unsupported provider/,
    );
  });

  test('posts the activation request with a fresh requestId', async () => {
    const fetchCalls: Array<[string, RequestInit | undefined]> = [];
    stubFetchReturning(async (url: string, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return mockResponse({ code: 200, msg: 'success', data: 462029, success: true });
    });

    await activateQuotaGiftReset('zai-coding-plan', { recordId: 462029, resetType: 'FIVE_HOUR' });

    assert.equal(fetchCalls.length, 1);
    const [url, init] = fetchCalls[0]!;
    assert.equal(url, 'https://api.z.ai/api/biz/customer-package-reset/use');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-token');
    // SAFETY: body is the JSON stringified by activateQuotaGiftReset itself;
    // only the documented activation fields are read back.
    const body = JSON.parse(String(init?.body)) as {
      targetType?: unknown;
      resetType?: unknown;
      recordId?: unknown;
      requestId?: unknown;
    };
    assert.equal(body.targetType, 'PERSONAL');
    assert.equal(body.resetType, 'FIVE_HOUR');
    assert.equal(body.recordId, 462029);
    assert.match(String(body.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('throws the API message when activation is rejected', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ code: 400, msg: 'reset already used', success: false })));

    await assert.rejects(
      activateQuotaGiftReset('zai-coding-plan', { recordId: 1, resetType: 'WEEK' }),
      /reset already used/,
    );
  });
});

describe('Zhipu AI Coding Plan quota provider (VS Code parity)', () => {
  test('maps CREDIT_LIMIT entries to 5-hour and weekly windows with credit labels and plan level', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      msg: '操作成功',
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 900, remaining: 1100, percentage: 45, nextResetTime: 1797930060000 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 6000, remaining: 4000, percentage: 60, nextResetTime: 1798425600000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 5, nextResetTime: 1798425600000 },
        ],
        level: 'lite',
      },
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');
    const windows = result.usage!.windows;

    assert.equal(result.ok, true);
    assert.equal(result.planLabel, 'lite');
    assert.equal(windows['5h']!.usedPercent, 45);
    assert.equal(windows['5h']!.windowSeconds, 5 * 60 * 60);
    assert.equal(windows['5h']!.resetAt, 1797930060000);
    assert.equal(windows['5h']!.valueLabel, '900 / 2k credits');
    assert.equal(windows.weekly!.usedPercent, 60);
    assert.equal(windows.weekly!.windowSeconds, 7 * 24 * 60 * 60);
    assert.equal(windows.weekly!.resetAt, 1798425600000);
    assert.equal(windows.weekly!.valueLabel, '6k / 10k credits');
    assert.equal(windows['MCP Tools']!.usedPercent, 5);
    assert.equal(windows['MCP Tools']!.windowSeconds, 30 * 24 * 60 * 60);
  });

  test('still maps legacy TOKENS_LIMIT entries without credit labels', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30 },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows['5h']!.usedPercent, 30);
    assert.equal(result.usage!.windows['5h']!.windowSeconds, 5 * 60 * 60);
    assert.equal(result.usage!.windows['5h']!.valueLabel, undefined);
  });

  test('derives the used percent from currentValue/usage when percentage is missing', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 900 },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows['5h']!.usedPercent, 45);
    assert.equal(result.usage!.windows['5h']!.valueLabel, '900 / 2k credits');
  });

  test('clamps out-of-range percentages and the derived fallback to [0, 100]', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 150 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: -20 },
        ],
      },
    })));

    const clamped = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(clamped.ok, true);
    assert.equal(clamped.usage!.windows['5h']!.usedPercent, 100);
    assert.equal(clamped.usage!.windows['5h']!.remainingPercent, 0);
    assert.equal(clamped.usage!.windows['MCP Tools']!.usedPercent, 0);
    assert.equal(clamped.usage!.windows['MCP Tools']!.remainingPercent, 100);

    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 200 },
        ],
      },
    })));

    const fallback = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(fallback.ok, true);
    assert.equal(fallback.usage!.windows['5h']!.usedPercent, 100);
  });

  test('reports non-finite MCP Tools percentages as unknown instead of clamping them', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: Number.POSITIVE_INFINITY },
        ],
      },
    })));

    const infinite = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(infinite.ok, true);
    assert.equal(infinite.usage!.windows['MCP Tools']!.usedPercent, null);
    assert.equal(infinite.usage!.windows['MCP Tools']!.remainingPercent, null);

    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: Number.NaN },
        ],
      },
    })));

    const nan = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(nan.ok, true);
    assert.equal(nan.usage!.windows['MCP Tools']!.usedPercent, null);
    assert.equal(nan.usage!.windows['MCP Tools']!.remainingPercent, null);
  });

  test('surfaces business failures reported inside HTTP 200 bodies', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 401,
      msg: '令牌已过期或验证不正确',
      success: false,
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, '令牌已过期或验证不正确');
    assert.equal(result.usage, null);
  });

  test('treats a null code without success:false as success', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: null,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20 },
        ],
      },
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows['5h']!.usedPercent, 20);
  });

  test('falls back to the code when the envelope message is not text', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 1002,
      msg: 42,
      success: false,
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'API error: 1002');
  });

  test('falls back to the code when the envelope carries no message', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      code: 1001,
      success: false,
    })));

    const result = await fetchQuotaForProvider('zhipuai-coding-plan');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'API error: 1001');
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
});

describe('DeepInfra quota provider (VS Code parity)', () => {
  test('shows a negative stripe_balance as spendable credit', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ checklist: { stripe_balance: -50.75 } })));

    const result = await fetchQuotaForProvider('deepinfra');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'deepinfra');
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$50.75');
  });

  test('shows a positive stripe_balance as money owed', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ checklist: { stripe_balance: '5.50' } })));

    const result = await fetchQuotaForProvider('deepinfra');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '-$5.50');
  });

  test('treats a blank balance as missing data, not as $0.00', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ checklist: { stripe_balance: '  ' } })));

    const result = await fetchQuotaForProvider('deepinfra');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'No quota data in response');
  });

  test('asks to re-authenticate on 401', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('deepinfra');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Session expired — please re-authenticate with DeepInfra');
  });
});

describe('DeepSeek quota provider (VS Code parity)', () => {
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

  test('reports no quota data instead of guessing a currency it does not know', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [
        { currency: 'EUR', total_balance: '12.00', granted_balance: '0.00', topped_up_balance: '12.00' },
      ],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'No quota data in response');
  });

  test('selects CNY entry when USD balance is zero and CNY balance is positive', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '100.00', granted_balance: '0.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      ],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '¥100.00');
  });

  test('prefers USD entry when both USD and CNY have positive balance', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '100.00', granted_balance: '0.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '3.55', granted_balance: '0.00', topped_up_balance: '3.55' },
      ],
    })));

    const result = await fetchQuotaForProvider('deepseek');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$3.55');
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

describe('Cursor quota provider (VS Code parity)', () => {
  // readCredential reads the cursor credential from the isolated data directory.
  const cursorCredentialPath = path.join(temporaryQuotaDataDirectory, 'quota', 'cursor.json');
  beforeEach(() => {
    fs.mkdirSync(path.dirname(cursorCredentialPath), { recursive: true });
    fs.writeFileSync(cursorCredentialPath, JSON.stringify({ accessToken: 'test-token' }));
  });
  afterEach(() => {
    fs.rmSync(cursorCredentialPath, { force: true });
  });

  const routeCursorApi = (routes: Record<string, { status?: number; body?: unknown }>, capture?: (url: string, body: string) => void): void => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      const match = Object.entries(routes).find(([fragment]) => target.includes(fragment));
      capture?.(target, typeof init?.body === 'string' ? init.body : '');
      if (!match) return mockResponse({}, { status: 404 });
      const { status = 200, body = {} } = match[1];
      return mockResponse(body, { status });
    }) as typeof fetch;
  };

  const sparseEnterpriseUsage = { billingCycleStart: '1787932328088', billingCycleEnd: '1787932328088', displayThreshold: 100 };

  const enterpriseRoutes: Record<string, { status?: number; body?: unknown }> = {
    GetCurrentPeriodUsage: { body: sparseEnterpriseUsage },
    GetPlanInfo: { body: { planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleEnd: '1788220800000' } } },
    GetCreditGrantsBalance: { body: {} },
    full_stripe_profile: { body: { teamId: 424242, isTeamMember: true, membershipType: 'enterprise' } },
    'auth/usage': { body: { 'gpt-4': { numRequests: 590, maxRequestUsage: 1000 } } },
    GetHardLimit: { body: { hardLimit: 12500, hardLimitPerUser: 250 } },
    GetTeamSpend: { body: { teamMemberSpend: [] } },
    GetMe: { body: { userId: 424242, teamId: 424242, isEnterpriseUser: true } },
  };

  test('keeps the planUsage path for Pro accounts', async () => {
    const urls: string[] = [];
    routeCursorApi({ GetCurrentPeriodUsage: { body: { enabled: true, planUsage: { totalPercentUsed: 42 }, billingCycleEnd: '1788220800000' } } }, (url) => { urls.push(url); });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.deepEqual(urls.sort(), [
      `${'https://api2.cursor.sh'}/aiserver.v1.DashboardService/GetCreditGrantsBalance`,
      `${'https://api2.cursor.sh'}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      `${'https://api2.cursor.sh'}/aiserver.v1.DashboardService/GetPlanInfo`,
    ]);
    assert.equal(result.usage!.windows.billing_cycle!.usedPercent, 42);
  });

  test('clamps planUsage percentages above 100', async () => {
    routeCursorApi({ GetCurrentPeriodUsage: { body: { enabled: true, planUsage: { totalPercentUsed: 150 }, billingCycleEnd: '1788220800000' } } });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.billing_cycle!.usedPercent, 100);
  });

  test('clamps negative planUsage percentages to zero', async () => {
    routeCursorApi({ GetCurrentPeriodUsage: { body: { enabled: true, planUsage: { totalPercentUsed: -20 }, billingCycleEnd: '1788220800000' } } });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.billing_cycle!.usedPercent, 0);
  });

  test('keeps planUsage percentage null when it is missing', async () => {
    routeCursorApi({ GetCurrentPeriodUsage: { body: { enabled: true, planUsage: {}, billingCycleEnd: '1788220800000' } } });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.billing_cycle!.usedPercent, null);
  });

  test('falls back to auth/usage and team-scoped GetHardLimit for enterprise accounts', async () => {
    let hardLimitBody = '';
    routeCursorApi(enterpriseRoutes, (url, body) => {
      if (url.includes('GetHardLimit')) hardLimitBody = body;
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.providerName, 'Cursor Enterprise');
    assert.equal(result.usage!.windows.billing_cycle!.valueLabel, '590 / 1000');
    assert.equal(result.usage!.windows.billing_cycle!.usedPercent, 59);
    assert.equal(result.usage!.windows.on_demand, undefined);
    assert.equal(hardLimitBody, JSON.stringify({ teamId: '424242' }));
  });

  test('reports enterprise windowSeconds as the billing-cycle duration, not time until reset', async () => {
    routeCursorApi({
      ...enterpriseRoutes,
      GetTeamSpend: { body: { teamMemberSpend: [{ userId: 424242, spendCents: 672 }] } },
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    // planInfo.billingCycleEnd 1788220800000 - usage.billingCycleStart 1787932328088 = 288471s
    assert.equal(result.usage!.windows.billing_cycle!.windowSeconds, 288471);
    assert.equal(result.usage!.windows.on_demand!.windowSeconds, 288471);
  });

  test('reports enterprise windowSeconds as null when the billing-cycle start is missing', async () => {
    routeCursorApi({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: { body: { billingCycleEnd: '1787932328088', displayThreshold: 100 } },
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.billing_cycle!.windowSeconds, null);
  });

  test('reports on-demand spend from GetTeamSpend matched by userId', async () => {
    routeCursorApi({
      ...enterpriseRoutes,
      GetTeamSpend: { body: { teamMemberSpend: [{ userId: 999999, spendCents: 100 }, { userId: 424242, spendCents: 672 }] } },
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.on_demand!.valueLabel, '$6.72 / $250.00');
    assert.equal(result.usage!.windows.on_demand!.usedPercent, 2.688);
  });

  test('picks the largest request bucket and skips metadata', async () => {
    routeCursorApi({
      ...enterpriseRoutes,
      'auth/usage': { body: { startOfMonth: '2026-08-01', 'gpt-4o': { numRequests: 120, maxRequestUsage: 500 }, 'gpt-4': { numRequests: 829, maxRequestUsage: 1000 } } },
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.billing_cycle!.valueLabel, '829 / 1000');
  });

  test('does not report success from plan name alone', async () => {
    routeCursorApi({
      GetCurrentPeriodUsage: { body: sparseEnterpriseUsage },
      GetPlanInfo: { body: { planInfo: { planName: 'Enterprise', billingCycleEnd: '1788220800000' } } },
      full_stripe_profile: { body: { teamId: 424242, isTeamMember: true } },
    });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'No active Cursor subscription');
  });

  test('reports a disabled subscription as an error', async () => {
    routeCursorApi({ GetCurrentPeriodUsage: { body: { enabled: false } } });

    const result = await fetchQuotaForProvider('cursor');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'No active Cursor subscription');
  });
});

describe('Ollama Cloud quota (API key)', () => {
  const apiKey = 'test-ollama-key';
  const readApiKey = () => apiKey;

  const period = { from: '2026-09-28T20:49:41Z', until: '2026-10-28T20:49:41Z' };
  const balance = (
    included: {
      allowance_usd?: number | string;
      balance_usd?: number | string;
      period?: { from: string; until: string };
      session?: { remaining_percent?: number; resets_at?: string };
      weekly?: { remaining_percent?: number; resets_at?: string };
    },
    purchased?: { balance_usd: number },
  ) => JSON.stringify(purchased === undefined ? { included } : { included, purchased });

  test('reads the monthly credit pool as a percentage with the reset time', async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      assert.equal(init.method, url.endsWith('/api/me') ? 'POST' : 'GET');
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${apiKey}`);
      assert.ok(init.signal instanceof AbortSignal);
      if (url === 'https://ollama.com/api/me') return new Response(JSON.stringify({ Plan: 'pro' }));
      assert.equal(url, 'https://ollama.com/api/balance');
      return new Response(balance({ allowance_usd: 60, balance_usd: 50.12376, period }));
    };
    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
    assert.equal(result.ok, true);
    assert.ok(result.usage);
    assert.deepEqual(Object.keys(result.usage.windows), ['monthly']);
    assert.equal(Number(result.usage.windows.monthly!.usedPercent!.toFixed(4)), 16.4604);
    assert.equal(result.usage.windows.monthly!.resetAt, Date.parse('2026-10-28T20:49:41Z'));
    assert.equal(result.planLabel, 'pro');
    // The key must never come back through the result.
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  });

  test('drops the plan label when /api/me fails, keeping the window', async () => {
    const fetchImpl = async (url: string) => (
      url === 'https://ollama.com/api/me'
        ? new Response('', { status: 500 })
        : new Response(balance({ allowance_usd: 60, balance_usd: 30, period }))
    );
    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.planLabel ?? null, null);
    assert.ok(result.usage!.windows.monthly);
  });

  for (const { included, percent } of [
    { included: { allowance_usd: 60, balance_usd: 50.12376, period }, percent: 16.4604 },
    { included: { allowance_usd: '60', balance_usd: '50.12376', period }, percent: 16.4604 },
    { included: { allowance_usd: 60, balance_usd: 0, period }, percent: 100 },
    { included: { allowance_usd: 60, balance_usd: -5, period }, percent: 100 },
  ]) {
    test(`maps the monthly pool ${JSON.stringify(included)}`, async () => {
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async (url: string) => (url === 'https://ollama.com/api/me' ? new Response('{}') : new Response(balance(included))) });
      assert.equal(result.ok, true);
      assert.equal(Number(result.usage!.windows.monthly!.usedPercent!.toFixed(4)), percent);
    });
  }

  test('omits the reset when the payload carries no period', async () => {
    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async () => new Response(balance({ allowance_usd: 60, balance_usd: 30 })) });
    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.monthly!.resetAt, null);
  });

  test('maps a legacy plan session and weekly limit into windows', async () => {
    // A legacy plan reports remaining_percent rather than a dollar pool.
    const body = balance({
      session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
      weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
    }, { balance_usd: 25 });

    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async (url: string) => (url === 'https://ollama.com/api/me' ? new Response('{}') : new Response(body)) });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage!.windows), ['session', 'weekly', 'purchased_credits']);
    assert.equal(result.usage!.windows.session!.usedPercent, 25);
    assert.equal(result.usage!.windows.session!.resetAt, Date.parse('2026-10-01T07:00:00Z'));
    assert.equal(result.usage!.windows.weekly!.usedPercent, 60);
    assert.equal(result.usage!.windows.weekly!.resetAt, Date.parse('2026-10-05T00:00:00Z'));
    assert.equal(result.usage!.windows.purchased_credits!.valueLabel, '$25.00');
  });

  test('clamps and skips an unusable legacy limit', async () => {
    const body = balance({ session: { remaining_percent: 140 }, weekly: { remaining_percent: -5 } });
    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async (url: string) => (url === 'https://ollama.com/api/me' ? new Response('{}') : new Response(body)) });
    assert.equal(result.usage!.windows.session!.usedPercent, 0);
    assert.equal(result.usage!.windows.weekly!.usedPercent, 100);
  });

  test('shows purchased credit only while it is positive', async () => {
    const withCredit = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async () => new Response(balance({ allowance_usd: 60, balance_usd: 30, period }, { balance_usd: 12.5 })) });
    assert.equal(withCredit.ok, true);
    assert.deepEqual(Object.keys(withCredit.usage!.windows), ['monthly', 'purchased_credits']);
    assert.equal(withCredit.usage!.windows.purchased_credits!.valueLabel, '$12.50');
    assert.equal(withCredit.usage!.windows.purchased_credits!.usedPercent, null);

    for (const purchased of [undefined, { balance_usd: 0 }, { balance_usd: -1 }]) {
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl: async () => new Response(balance({ allowance_usd: 60, balance_usd: 30 }, purchased)) });
      assert.deepEqual(Object.keys(result.usage!.windows), ['monthly']);
    }
  });

  for (const body of [{}, { included: {} }, { included: { balance_usd: 10 } }, { included: { allowance_usd: 0, balance_usd: 0 } }, { included: { allowance_usd: 'sixty', balance_usd: 10 } }, { included: { allowance_usd: 60 } }, { included: [{ allowance_usd: 60, balance_usd: 10, period }] }, null]) {
    test(`rejects a response without a usable pool: ${JSON.stringify(body)}`, async () => {
      const fetchImpl = async () => new Response(JSON.stringify(body));
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.usage, null);
      assert.equal(result.error, 'Ollama Cloud usage data could not be parsed');
    });
  }

  for (const status of [401, 403]) {
    test(`reports an auth failure for HTTP ${status}`, async () => {
      const fetchImpl = async () => new Response('{"error":"invalid credentials"}', { status });
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
      assert.equal(result.error, 'Ollama Cloud authentication failed');
    });
  }

  for (const status of [429, 500, 503]) {
    test(`reports HTTP ${status} without calling it an auth failure`, async () => {
      const fetchImpl = async () => new Response('', { status });
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
      assert.equal(result.error, `Ollama Cloud returned HTTP ${status}`);
    });
  }

  for (const failure of [new DOMException('Request timed out', 'TimeoutError'), new Error('Network unavailable')]) {
    test(`reports ${failure.message}`, async () => {
      const fetchImpl = async () => { throw failure; };
      const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
      assert.equal(result.error, failure.message);
    });
  }

  test('does not request usage without an API key', async () => {
    const result = await fetchOllamaCloudQuota({ readApiKey: () => undefined, fetchImpl: async () => { assert.fail('Unexpected request'); } });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
  });

  test('reports response body failures', async () => {
    const failure = new Error('Response body interrupted');
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    }));

    const result = await fetchOllamaCloudQuota({ readApiKey, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.usage, null);
    assert.equal(result.error, failure.message);
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

describe('Kimi for Coding credential lookup (VS Code parity)', () => {
  const sentKey = async (auth: Record<string, { type?: string; key: string; token?: string }>) => {
    let authorization: string | undefined;
    const result = await fetchKimiQuota({
      readAuth: () => auth,
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init.headers).get('Authorization') ?? undefined;
        return Response.json({ usage: null, limits: [] });
      },
    });
    return { result, authorization };
  };

  test('finds a China plan credential stored under kimi-code-plan-cn', async () => {
    const { result, authorization } = await sentKey({ 'kimi-code-plan-cn': { type: 'api', key: 'cn-key' } });
    assert.equal(result.ok, true);
    assert.equal(authorization, 'Bearer cn-key');
  });

  test('prefers the China plan credential over a leftover pre-split kimi-for-coding key', async () => {
    const { authorization } = await sentKey({
      'kimi-for-coding': { type: 'api', key: 'stale-key' },
      kimi: { type: 'api', key: 'older-key' },
      'kimi-code-plan-cn': { type: 'api', key: 'cn-key' },
    });
    assert.equal(authorization, 'Bearer cn-key');
  });

  test('still reads the global plan and the pre-split ids when they are the only credential', async () => {
    assert.equal((await sentKey({ 'kimi-code-plan-global': { key: 'global-key' } })).authorization, 'Bearer global-key');
    assert.equal((await sentKey({ 'kimi-for-coding': { key: 'legacy-key' } })).authorization, 'Bearer legacy-key');
  });

  test('skips a blank key and uses the token next to it', async () => {
    const { authorization } = await sentKey({ 'kimi-code-plan-cn': { key: '  ', token: 'cn-token' } });
    assert.equal(authorization, 'Bearer cn-token');
  });

  test('keeps a pre-split key ahead of the global plan, as before', async () => {
    const { authorization } = await sentKey({
      'kimi-code-plan-global': { key: 'global-key' },
      'kimi-for-coding': { key: 'legacy-key' },
    });
    assert.equal(authorization, 'Bearer legacy-key');
  });

  test('passes a deadline signal to the Kimi Code usages fetch', async () => {
    let usagesSignal: unknown;
    const result = await fetchKimiQuota({
      readAuth: () => ({ 'kimi-for-coding': { key: 'test-token' } }),
      fetchImpl: async (url, init) => {
        if (url === 'https://api.kimi.com/coding/v1/usages') usagesSignal = init?.signal;
        return Response.json({ usage: null, limits: [] });
      },
    });
    assert.equal(result.ok, true);
    assert.ok(usagesSignal instanceof AbortSignal);
  });

  test('shows the pay-as-you-go balance when the Kimi Code address refuses a platform key', async () => {
    const urls: string[] = [];
    const result = await fetchKimiQuota({
      readAuth: () => ({ 'kimi-for-coding': { key: 'platform-key' } }),
      fetchImpl: async (url) => {
        urls.push(url);
        return url === 'https://api.moonshot.ai/v1/users/me/balance'
          ? Response.json({ data: { available_balance: 12.345 } })
          : new Response('{}', { status: 401 });
      },
    });
    assert.deepEqual(urls, ['https://api.kimi.com/coding/v1/usages', 'https://api.moonshot.ai/v1/users/me/balance']);
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows.credits_balance?.valueLabel, '$12.35');
  });

  test('keeps the original 401 when the balance read fails too', async () => {
    const urls: string[] = [];
    const result = await fetchKimiQuota({
      readAuth: () => ({ 'kimi-for-coding': { key: 'platform-key' } }),
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response('{}', { status: 401 });
      },
    });
    assert.deepEqual(urls, ['https://api.kimi.com/coding/v1/usages', 'https://api.moonshot.ai/v1/users/me/balance']);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'API error: 401');
  });

  test('treats a 403 from the Kimi Code address like a 401', async () => {
    const result = await fetchKimiQuota({
      readAuth: () => ({ 'kimi-for-coding': { key: 'platform-key' } }),
      fetchImpl: async (url) => (url === 'https://api.moonshot.ai/v1/users/me/balance'
        ? Response.json({ data: { available_balance: 5 } })
        : new Response('{}', { status: 403 })),
    });
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows.credits_balance?.valueLabel, '$5.00');
  });
});

describe('Kimi for Coding ratio-based usage payload (VS Code parity)', () => {
  // Captured live from GET https://api.kimi.com/coding/v1/usages on 2026-10-08.
  // Migrated plans answer with a ratio-based `usages` map instead of the counted
  // `usage` block, and keep a coarser `limits[]` entry for the same 5-hour
  // window. `limit_month_code` is the code-typed share of `limit_month_total`,
  // not a second allowance, and is not shown.
  const migratedPlan = {
    limits: [{
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '50', remaining: '50', resetTime: '2026-10-08T11:50:22.234058Z' },
    }],
    usages: {
      limit_5h: { used_ratio: 0.495422, reset_time: '2026-10-08T11:50:22Z' },
      limit_month_total: { used_ratio: 0.2636, reset_time: '2026-10-18T00:00:00Z' },
      limit_month_code: { used_ratio: 0.1907, reset_time: '2026-10-18T00:00:00Z' },
    },
  };

  const run = async (payload: Parameters<typeof Response.json>[0]) => fetchKimiQuota({
    readAuth: () => ({ 'kimi-for-coding': { key: 'test-token' } }),
    fetchImpl: async () => Response.json(payload),
  });

  test('reads the 5h and monthly ratios and ignores the duplicate limits[] entry', async () => {
    const result = await run(migratedPlan);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.usage?.windows ?? {}), ['5h', 'monthly']);
    assert.ok(Math.abs((result.usage?.windows['5h']?.usedPercent ?? 0) - 49.5422) < 1e-9);
    assert.equal(result.usage?.windows['5h']?.windowSeconds, 18000);
    assert.equal(result.usage?.windows['5h']?.resetAt, Date.parse('2026-10-08T11:50:22Z'));
  });

  test('reports the monthly row as a plain percent so it follows the used/remaining setting', async () => {
    const result = await run(migratedPlan);
    assert.ok(Math.abs((result.usage?.windows.monthly?.usedPercent ?? 0) - 26.36) < 1e-9);
    assert.ok(Math.abs((result.usage?.windows.monthly?.remainingPercent ?? 0) - 73.64) < 1e-9);
    assert.equal(result.usage?.windows.monthly?.valueLabel, undefined);
    assert.equal(result.usage?.windows.monthly?.windowSeconds, null);
    assert.equal(result.usage?.windows.monthly?.resetAt, Date.parse('2026-10-18T00:00:00Z'));
  });

  test('maps limit_7d to the weekly window when the plan still serves it', async () => {
    const result = await run({ usages: { limit_7d: { used_ratio: 0.25, reset_time: null } } });
    assert.equal(result.usage?.windows.weekly?.usedPercent, 25);
    assert.equal(result.usage?.windows.weekly?.windowSeconds, 604800);
    assert.equal(result.usage?.windows.weekly?.valueLabel, undefined);
  });

  test('keeps a zero ratio and skips an entry without one', async () => {
    const result = await run({
      usages: {
        limit_5h: { used_ratio: 0, reset_time: null },
        limit_month_total: { used_ratio: 'not-a-number', reset_time: null },
      },
    });
    assert.equal(result.usage?.windows['5h']?.usedPercent, 0);
    assert.deepEqual(Object.keys(result.usage?.windows ?? {}), ['5h']);
  });

  test('still reads the counted payload from plans that have not migrated', async () => {
    const result = await run({
      usage: { limit: '100', used: '100', resetTime: '2026-08-04T06:21:48.514003Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '100', resetTime: '2026-08-03T07:21:48.514003Z' },
      }],
    });
    assert.deepEqual(Object.keys(result.usage?.windows ?? {}), ['weekly', 'Rate Limit (300m)']);
    assert.equal(result.usage?.windows.weekly?.usedPercent, 100);
    assert.equal(result.usage?.windows['Rate Limit (300m)']?.usedPercent, 0);
  });
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

describe('ZenMux quota provider (VS Code parity)', () => {
  const readCredential = () => ({ platformApiKey: 'test-token' });
  const documentedPayload = {
    success: true,
    data: { currency: 'usd', total_credits: 482.74, top_up_credits: 35.0, bonus_credits: 447.74 },
  };

  test('builds credits_balance from the documented PAYG payload', async () => {
    let requests = 0;
    const result = await fetchZenmuxQuota({
      readCredential,
      fetchImpl: async (url, options) => {
        requests += 1;
        assert.equal(url, 'https://zenmux.ai/api/v1/management/payg/balance');
        assert.equal(options.method, 'GET');
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer test-token');
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json(documentedPayload);
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'zenmux');
    assert.equal(result.configured, true);
    assert.ok(result.usage);
    assert.equal(result.usage.windows.credits_balance?.valueLabel, '$482.74');
    assert.equal(result.usage.windows.credits_balance?.usedPercent, null);
    assert.equal(JSON.stringify(result).includes('test-token'), false);
  });

  for (const { totalCredits, label } of [
    { totalCredits: 0, label: '$0.00' },
    { totalCredits: '0', label: '$0.00' },
    { totalCredits: 12.5, label: '$12.50' },
  ]) {
    test(`accepts finite total_credits ${JSON.stringify(totalCredits)}`, async () => {
      const result = await fetchZenmuxQuota({
        readCredential,
        fetchImpl: async () => Response.json({ success: true, data: { currency: 'usd', total_credits: totalCredits } }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.usage?.windows.credits_balance?.valueLabel, label);
    });
  }

  for (const payload of [
    {}, null, [], { success: true }, { success: true, data: null },
    { success: true, data: {} }, { success: true, data: { total_credits: '' } },
    { success: true, data: { total_credits: 'NaN' } }, { success: true, data: { total_credits: null } },
  ]) {
    test(`rejects invalid payload ${JSON.stringify(payload)} instead of showing zero`, async () => {
      const result = await fetchZenmuxQuota({ readCredential, fetchImpl: async () => Response.json(payload) });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.error, 'No quota data in response');
      assert.equal(result.usage, null);
    });
  }

  test('does not request usage without a Platform API key', async () => {
    const result = await fetchZenmuxQuota({
      readCredential: () => null,
      fetchImpl: async () => { assert.fail('Unexpected request'); },
    });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not configured');
  });

  test('reports HTTP 401 as an invalid Platform API key', async () => {
    const result = await fetchZenmuxQuota({ readCredential, fetchImpl: async () => new Response(null, { status: 401 }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid ZenMux Platform API key');
  });

  test('reports invalid JSON as a parse failure', async () => {
    const result = await fetchZenmuxQuota({ readCredential, fetchImpl: async () => new Response('{') });
    assert.equal(result.error, 'Invalid response from provider');
    assert.equal(result.ok, false);
    assert.equal(result.usage, null);
  });
});

describe('Kilo Code quota provider (VS Code parity)', () => {
  const readAuth = () => ({ kilo: { key: 'test-token' } });
  const readOrganizationId = () => null;

  test('builds credits_balance from the documented balance payload', async () => {
    let requests = 0;
    const result = await fetchKiloQuota({
      readAuth,
      readOrganizationId,
      fetchImpl: async (url, options) => {
        requests += 1;
        assert.equal(url, 'https://api.kilo.ai/api/profile/balance');
        assert.equal(options.method, 'GET');
        const headers = new Headers(options.headers);
        assert.equal(headers.get('Authorization'), 'Bearer test-token');
        assert.equal(headers.get('Content-Type'), 'application/json');
        assert.equal(headers.get('x-kilocode-organizationid'), null);
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json({ balance: 12.5 });
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'kilo');
    assert.equal(result.configured, true);
    assert.ok(result.usage);
    assert.equal(result.usage.windows.credits_balance?.valueLabel, '$12.50');
    assert.equal(JSON.stringify(result).includes('test-token'), false);
  });

  test('sends the organization header from the auth entry', async () => {
    const result = await fetchKiloQuota({
      readAuth: () => ({ kilo: { key: 'test-token', organizationId: 'org-123' } }),
      readOrganizationId,
      fetchImpl: async (_url, options) => {
        assert.equal(new Headers(options.headers).get('x-kilocode-organizationid'), 'org-123');
        return Response.json({ balance: 4 });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes('org-123'), false);
  });

  test('falls back to OpenCode provider options when auth has no organization', async () => {
    const result = await fetchKiloQuota({
      readAuth,
      readOrganizationId: () => 'config-org',
      fetchImpl: async (_url, options) => {
        assert.equal(new Headers(options.headers).get('x-kilocode-organizationid'), 'config-org');
        return Response.json({ balance: 4 });
      },
    });
    assert.equal(result.ok, true);
  });

  test('accepts a literal zero balance', async () => {
    const result = await fetchKiloQuota({
      readAuth,
      readOrganizationId,
      fetchImpl: async () => Response.json({ balance: 0 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows.credits_balance?.valueLabel, '$0.00');
  });

  test('rejects a missing balance instead of showing zero', async () => {
    const result = await fetchKiloQuota({
      readAuth,
      readOrganizationId,
      fetchImpl: async () => Response.json({}),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });

  test('does not request usage without a valid credential', async () => {
    const result = await fetchKiloQuota({
      readAuth: () => ({}),
      readOrganizationId,
      fetchImpl: async () => { assert.fail('Unexpected request'); },
    });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
  });

  test('reports HTTP 401 as session expired', async () => {
    const result = await fetchKiloQuota({
      readAuth,
      readOrganizationId,
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Session expired — please re-authenticate with Kilo Code');
  });
});

describe('xAI quota provider (VS Code parity)', () => {
  const xaiResponse = (usedPercent: number): Response => {
    const bytes = Buffer.alloc(5);
    bytes[0] = 0x0d;
    bytes.writeFloatLE(usedPercent, 1);
    return new Response(new Uint8Array(bytes));
  };

  test('reads usage with the stored access token while it is still valid', async () => {
    const requests: string[] = [];
    const result = await fetchXaiQuota({
      readAuth: () => ({ xai: { type: 'oauth', access: 'valid-access', refresh: 'rotating-1', expires: Date.now() + 3_600_000 } }),
      fetchImpl: async (url) => {
        requests.push(url);
        return xaiResponse(42);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows.billing_cycle?.usedPercent, 42);
    assert.deepEqual(requests, ['https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig']);
  });

  test('never exchanges the rotating refresh token when the access token is expired', async () => {
    const requests: string[] = [];
    const result = await fetchXaiQuota({
      readAuth: () => ({ xai: { type: 'oauth', access: 'stale-access', refresh: 'rotating-1', expires: Date.now() - 1_000 } }),
      fetchImpl: async (url) => {
        requests.push(url);
        return xaiResponse(42);
      },
    });

    assert.deepEqual(requests.filter((url) => url.includes('auth.x.ai')), []);
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.error ?? '', /expired/i);
  });

  test('fails the provider result for an over-cap binary body (#1282)', async () => {
    const result = await fetchXaiQuota({
      readAuth: () => ({ xai: { type: 'oauth', access: 'valid-access', refresh: 'rotating-1', expires: Date.now() + 3_600_000 } }),
      fetchImpl: async () => new Response(new Uint8Array(1024 * 1024 + 1)),
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /exceeded the 1 MiB limit/);
  });

  test('reports a missing credential as unconfigured without contacting xAI', async () => {
    let requests = 0;
    const result = await fetchXaiQuota({
      readAuth: () => ({}),
      fetchImpl: async () => {
        requests += 1;
        return xaiResponse(42);
      },
    });

    assert.equal(result.configured, false);
    assert.equal(requests, 0);
  });
});

describe("Google quota provider (VS Code parity) - #545", () => {
  beforeEach(() => {
    configureOpenCodeCredentials({ list: async () => [oauth("google")] });
  });

  afterEach(() => {
    configureOpenCodeCredentials({ list: async () => baseCredentialList() });
  });

  for (const { label, remainingFraction, expectedUsed, expectedRemaining } of [
    { label: "clamps a negative remainingFraction to 100 used", remainingFraction: -0.5, expectedUsed: 100, expectedRemaining: 0 },
    { label: "keeps an in-range remainingFraction unclamped", remainingFraction: 0.75, expectedUsed: 25, expectedRemaining: 75 },
  ]) {
    test(label + " on the bucket and model-data paths", async () => {
      stubFetchReturning(async (url) => {
        if (url.endsWith(":retrieveUserQuota")) {
          return mockResponse({ buckets: [{ modelId: "gemini-bucket", remainingFraction, resetTime: "2026-10-28T10:00:00Z" }] });
        }
        if (url.endsWith(":fetchAvailableModels")) {
          return mockResponse({ models: { "gemini-model": { quotaInfo: { remainingFraction, resetTime: "2026-10-28T10:00:00Z" } } } });
        }
        return mockResponse({});
      });

      const result = await fetchQuotaForProvider("google");

      assert.equal(result.ok, true);
      const bucketWindow = result.usage?.models?.["gemini/gemini-bucket"]?.windows["per-model"];
      assert.equal(bucketWindow?.usedPercent, expectedUsed);
      assert.equal(bucketWindow?.remainingPercent, expectedRemaining);
      const modelWindow = result.usage?.models?.["gemini/gemini-model"]?.windows["per-model"];
      assert.equal(modelWindow?.usedPercent, expectedUsed);
      assert.equal(modelWindow?.remainingPercent, expectedRemaining);
    });
  }
});
describe('Meta quota provider', () => {
  // Shape verified live against POST https://api.meta.ai/muse-code/key (2026-10-27).
  const usagePayload = {
    is_subs_active: true,
    require_payment: false,
    subs_tier_name: 'Muse Code High Usage',
    subs_usage: {
      window: { used_percent: 6, window_duration_mins: 300, resets_at: 1793090405 },
      weekly: { used_percent: 10, resets_at: 1793577600 },
    },
  };

  test('maps the rolling and weekly windows from the plan payload', async () => {
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse(usagePayload),
    });

    assert.equal(result.ok, true);
    assert.equal(result.planLabel, 'Muse Code High Usage');
    assert.equal(result.usage?.windows['5h'].usedPercent, 6);
    assert.equal(result.usage?.windows['5h'].windowSeconds, 18000);
    assert.equal(result.usage?.windows.weekly.usedPercent, 10);
    assert.equal(result.usage?.windows.weekly.windowSeconds, 604800);
  });

  test('clamps out-of-range percentages to [0, 100] and keeps a missing one unknown', async () => {
    const clamped = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse({
        is_subs_active: true,
        subs_usage: {
          window: { used_percent: 150, window_duration_mins: 300 },
          weekly: { used_percent: -20 },
        },
      }),
    });

    assert.equal(clamped.ok, true);
    assert.equal(clamped.usage?.windows['5h'].usedPercent, 100);
    assert.equal(clamped.usage?.windows['5h'].remainingPercent, 0);
    assert.equal(clamped.usage?.windows.weekly.usedPercent, 0);
    assert.equal(clamped.usage?.windows.weekly.remainingPercent, 100);

    const missing = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse({
        is_subs_active: true,
        subs_usage: {
          window: { window_duration_mins: 300 },
          weekly: {},
        },
      }),
    });

    assert.equal(missing.ok, true);
    assert.equal(missing.usage?.windows['5h'].usedPercent, null);
    assert.equal(missing.usage?.windows.weekly.usedPercent, null);
  });

  test('falls back to the Muse CLI account token when the key endpoint refuses the minted key', async () => {
    const requests: string[] = [];
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async (_url, options) => {
        requests.push(new Headers(options.headers).get('Authorization') ?? '');
        return requests.length === 1
          ? mockResponse({ title: 'Authentication Error' }, { ok: false, status: 401 })
          : mockResponse(usagePayload);
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(requests, ['Bearer LLM|test-minted-key', 'Bearer dca:test-account-token']);
  });

  test('reports a 402 wall as a distinct quota-exhausted state', async () => {
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse(
        { quota: { limitKind: 'weekly', resetsAtMs: 1793577600000 } },
        { ok: false, status: 402 },
      ),
    });

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.quotaExhausted, true);
    assert.equal(result.quotaResetAt, 1793577600000);
  });

  test('surfaces the provider message on the require_payment wall instead of a bare error', async () => {
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse({
        is_subs_active: true,
        require_payment: true,
        message: 'Payment required to continue the Meta plan',
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.quotaExhausted, true);
    assert.match(result.error ?? '', /Payment required to continue the Meta plan/);
  });

  test('falls back to detail for the 402/429 exhausted message', async () => {
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse(
        { detail: 'Meta weekly limit reached', quota: { limitKind: 'weekly', resetsAtMs: 1793577600000 } },
        { ok: false, status: 429 },
      ),
    });

    assert.equal(result.ok, false);
    assert.equal(result.quotaExhausted, true);
    assert.match(result.error ?? '', /Meta weekly limit reached/);
  });

  test('reports an empty reading when an active payload carries no subs_usage (post-roll shape)', async () => {
    // Shape captured live on 2026-10-28 in the post-roll state: 200,
    // is_subs_active true, require_payment false, tier named, subs_usage
    // absent entirely.
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse({
        is_subs_active: true,
        require_payment: false,
        subs_tier_name: 'Muse Code High Usage',
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.planLabel, 'Muse Code High Usage');
    assert.equal(result.usage?.windows.rolling.usedPercent, null);
    assert.equal(result.usage?.windows.rolling.windowSeconds, null);
    assert.equal(result.usage?.windows.weekly.usedPercent, null);
    assert.equal(result.usage?.windows.weekly.windowSeconds, 604800);
  });

  test('reports an empty reading when subs_usage is empty or its windows are null', async () => {
    for (const subsUsage of [{}, { window: null, weekly: null }]) {
      const result = await fetchMetaQuota({
        readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
        readAccountToken: () => 'dca:test-account-token',
        fetchImpl: async () => mockResponse({ is_subs_active: true, subs_usage: subsUsage }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.usage?.windows.rolling.usedPercent, null);
      assert.equal(result.usage?.windows.weekly.usedPercent, null);
    }
  });

  test('reports no quota data when the payload carries no usage windows and no active flag', async () => {
    resetMetaQuotaCache();
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => mockResponse({}),
    });

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Usage unknown — Meta plan-usage read returned no quota data');
    assert.equal(result.failureClass, 'no-data');
    assert.equal(result.lastSuccessAt, null);
  });

  test('carries the last success timestamp on a later failure, and the failure class', async () => {
    resetMetaQuotaCache();
    const deps = {
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
    };
    const okResult = await fetchMetaQuota({ ...deps, fetchImpl: async () => mockResponse(usagePayload) });
    assert.equal(okResult.ok, true);
    assert.equal(okResult.lastSuccessAt, okResult.fetchedAt);

    const failResult = await fetchMetaQuota({ ...deps, fetchImpl: async () => mockResponse({}, { ok: false, status: 500 }) });
    assert.equal(failResult.ok, false);
    assert.equal(failResult.failureClass, 'http-error');
    assert.equal(failResult.lastSuccessAt, okResult.fetchedAt);
    resetMetaQuotaCache();
  });

  test('classifies a body-read transport failure as transport, not malformed', async () => {
    resetMetaQuotaCache();
    const result = await fetchMetaQuota({
      readAuth: () => ({ meta: { type: 'key', key: 'LLM|test-minted-key' } }),
      readAccountToken: () => 'dca:test-account-token',
      fetchImpl: async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'transport');
    assert.equal(result.error, 'terminated');
    resetMetaQuotaCache();
  });

  test('reports not configured without a meta credential', async () => {
    let requests = 0;
    const result = await fetchMetaQuota({
      readAuth: () => ({}),
      readAccountToken: () => null,
      fetchImpl: async () => {
        requests += 1;
        return mockResponse(usagePayload);
      },
    });

    assert.equal(result.configured, false);
    assert.equal(requests, 0);
  });
});

describe('Mistral quota provider (VS Code parity)', () => {
  test('dispatch reaches the fetcher: a live key answers ok with console-only usage', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    stubFetchReturning((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(mockResponse({ object: 'list', data: [{ id: 'mistral-large-latest' }] }));
    });

    const result = await fetchQuotaForProvider('mistral');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'mistral');
    assert.equal(result.providerName, 'Mistral AI');
    assert.equal(result.configured, true);
    assert.equal(result.usage!.usageAvailability, 'console-only');
    assert.deepEqual(result.usage!.windows, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], 'https://api.mistral.ai/v1/models');
    assert.equal(new Headers(calls[0]![1]?.headers).get('Authorization'), 'Bearer test-token');
  });

  test('lists mistral as configured from the enrolled key credential', async () => {
    const configured = await listConfiguredQuotaProviders();
    assert.equal(configured.includes('mistral'), true);
  });

  test('maps 401 and 403 to the unauthorized class', async () => {
    for (const status of [401, 403]) {
      stubFetchFailing(async () => ({}), { ok: false, status });
      const result = await fetchQuotaForProvider('mistral');
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.error, 'Invalid or revoked API key \u2014 Mistral rejected the enrolled credential');
    }
  });

  test('maps other HTTP failures to API error', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 500 });
    const result = await fetchQuotaForProvider('mistral');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'API error: 500');
  });

  test('reports no quota data on a 200 payload without the data array', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ object: 'list' })));
    const result = await fetchQuotaForProvider('mistral');
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });

  test('reports a normalized timeout error', async () => {
    stubFetchReturning(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    const result = await fetchQuotaForProvider('mistral');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Request timed out');
  });

  test('fetcher with no enrolled credential is not configured and sends nothing', async () => {
    let fetchCalls = 0;
    const result = await fetchMistralQuota({
      readAuth: () => ({}),
      fetchImpl: async () => { fetchCalls += 1; return mockResponse({ data: [] }); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Not configured');
    assert.equal(fetchCalls, 0);
  });

  test('fetcher falls through a blank key to the access field', async () => {
    const authorizations: Array<string | null> = [];
    const result = await fetchMistralQuota({
      readAuth: () => ({ mistral: { key: ' ', access: 'real-access' } }),
      fetchImpl: async (_url: string, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('Authorization'));
        return mockResponse({ data: [] });
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(authorizations, ['Bearer real-access']);
  });
});

describe('Wafer quota provider (VS Code parity) - #616', () => {
  const run = async (payload: {
    remaining_included_requests?: number;
    included_request_limit?: number;
    overage_request_count?: number;
    current_period_used_percent?: number;
  }) => {
    stubFetchReturning(async () => mockResponse(payload));
    return fetchQuotaForProvider('wafer');
  };

  test('derives usedPercent from remaining/limit when the percent is absent', async () => {
    const result = await run({ remaining_included_requests: 40, included_request_limit: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows['5h'].usedPercent, 60);
    assert.equal(result.usage?.windows['5h'].remainingPercent, 40);
    assert.equal(result.usage?.windows['5h'].valueLabel, '40 / 100 left');
  });

  test('clamps the derived usedPercent when remaining exceeds the limit', async () => {
    const result = await run({ remaining_included_requests: 120, included_request_limit: 100 });
    assert.equal(result.usage?.windows['5h'].usedPercent, 0);
  });

  test('reports a null usedPercent when the percent is absent and no counts can derive it', async () => {
    const result = await run({ overage_request_count: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.usage?.windows['5h'].usedPercent, null);
    assert.equal(result.usage?.windows['5h'].remainingPercent, null);
  });

  test('keeps a present percent, including overage above 100', async () => {
    const withinLimit = await run({ current_period_used_percent: 140 });
    assert.equal(withinLimit.usage?.windows['5h'].usedPercent, 100);

    const withOverage = await run({ current_period_used_percent: 140, overage_request_count: 5 });
    assert.equal(withOverage.usage?.windows['5h'].usedPercent, 140);
  });

  test('clamps a negative present percent at 0 in both cases', async () => {
    const withOverage = await run({ current_period_used_percent: -5, overage_request_count: 3 });
    assert.equal(withOverage.usage?.windows['5h'].usedPercent, 0);

    const withoutOverage = await run({ current_period_used_percent: -5 });
    assert.equal(withoutOverage.usage?.windows['5h'].usedPercent, 0);
  });
});

describe('VS Code quota key selection (#1759)', () => {
  afterEach(() => {
    configureOpenCodeCredentials({ list: async () => baseCredentialList() });
  });

  const blankKey = (integrationID: string, keyValue: string): CredentialEntry => ({
    id: `cred_${integrationID}`, integrationID, label: 'default', active: true,
    value: { type: 'key', key: keyValue },
  });
  const blankOauth = (integrationID: string, accessValue: string): CredentialEntry => ({
    id: `cred_${integrationID}`, integrationID, label: 'default', active: true,
    value: { type: 'oauth', methodID: 'test', access: accessValue, refresh: 'test-refresh', expires: 0 },
  });

  // Oracle: the shared asNonEmptyString selection — a credential whose
  // first field is empty or whitespace-only is no credential at all, so
  // the configured list and the fetch must agree it is not configured
  // and no request (in particular no blank `Bearer `/`token `) may leave.
  const cases: Array<{ provider: string; listedAs: string; credential: (blank: string) => CredentialEntry }> = [
    { provider: 'claude', listedAs: 'claude', credential: (b) => blankOauth('anthropic', b) },
    { provider: 'codex', listedAs: 'codex', credential: (b) => blankOauth('openai', b) },
    { provider: 'github-copilot', listedAs: 'github-copilot', credential: (b) => blankOauth('github-copilot', b) },
    { provider: 'zai-coding-plan', listedAs: 'zai-coding-plan', credential: (b) => blankKey('zai-coding-plan', b) },
    { provider: 'zhipuai-coding-plan', listedAs: 'zhipuai-coding-plan', credential: (b) => blankKey('zhipuai-coding-plan', b) },
    { provider: 'openrouter', listedAs: 'openrouter', credential: (b) => blankKey('openrouter', b) },
    { provider: 'nano-gpt', listedAs: 'nano-gpt', credential: (b) => blankKey('nano-gpt', b) },
    { provider: 'neuralwatt', listedAs: 'neuralwatt', credential: (b) => blankKey('neuralwatt', b) },
    { provider: 'deepseek', listedAs: 'deepseek', credential: (b) => blankKey('deepseek', b) },
    { provider: 'deepinfra', listedAs: 'deepinfra', credential: (b) => blankKey('deepinfra', b) },
    { provider: 'minimax-coding-plan', listedAs: 'minimax-coding-plan', credential: (b) => blankKey('minimax-coding-plan', b) },
    { provider: 'minimax-cn-coding-plan', listedAs: 'minimax-cn-coding-plan', credential: (b) => blankKey('minimax-cn-coding-plan', b) },
    { provider: 'wafer', listedAs: 'wafer', credential: (b) => blankKey('wafer', b) },
    { provider: 'mistral', listedAs: 'mistral', credential: (b) => blankKey('mistral', b) },
  ];

  for (const { provider, listedAs, credential } of cases) {
    for (const blank of [' ', '']) {
      test(`${provider} with a ${blank === '' ? 'empty' : 'whitespace-only'} first field is not configured and sends nothing`, async () => {
        configureOpenCodeCredentials({ list: async () => [credential(blank)] });
        let fetchCalls = 0;
        stubFetchReturning(() => { fetchCalls += 1; return Promise.resolve(mockResponse({})); });

        const result = await fetchQuotaForProvider(provider);
        assert.equal(result.configured, false, `${provider} fetch must read as not configured`);
        assert.equal(fetchCalls, 0, `${provider} must not send a blank bearer`);

        const configured = await listConfiguredQuotaProviders();
        assert.equal(configured.includes(listedAs), false, `${provider} must not list as configured`);
      });
    }
  }

  // The second field is the fallback the shared selector exists for:
  // every provider in the #1759 set pins it through its fetcher's
  // readAuth seam (the kimi/cline-pass pattern in this file), so a
  // selection regression in any one fetch path turns this suite red.
  // Oracle: the shared asNonEmptyString selection - a blank first field
  // falls through, so the fetcher is configured and every request it
  // sends carries the second field, never the blank first one.
  const fallthroughCases: Array<{
    provider: string;
    alias: string;
    first: 'key' | 'access';
    fetchQuota: (deps: { readAuth: () => Record<string, Record<string, string>> }) => Promise<{ configured: boolean }>;
    headerFor: (value: string) => string;
  }> = [
    { provider: 'claude', alias: 'anthropic', first: 'access', fetchQuota: fetchClaudeQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'codex', alias: 'openai', first: 'access', fetchQuota: fetchCodexQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'github-copilot', alias: 'github-copilot', first: 'access', fetchQuota: fetchCopilotQuota, headerFor: (v) => 'token ' + v },
    { provider: 'zai-coding-plan', alias: 'zai-coding-plan', first: 'key', fetchQuota: fetchZaiQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'zhipuai-coding-plan', alias: 'zhipuai-coding-plan', first: 'key', fetchQuota: fetchZhipuaiCodingPlanQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'openrouter', alias: 'openrouter', first: 'key', fetchQuota: fetchOpenRouterQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'nano-gpt', alias: 'nano-gpt', first: 'key', fetchQuota: fetchNanoGptQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'neuralwatt', alias: 'neuralwatt', first: 'key', fetchQuota: fetchNeuralwattQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'deepseek', alias: 'deepseek', first: 'key', fetchQuota: fetchDeepseekQuota, headerFor: (v) => 'Bearer ' + v },
    { provider: 'deepinfra', alias: 'deepinfra', first: 'key', fetchQuota: fetchDeepinfraQuota, headerFor: (v) => 'Bearer ' + v },
  ];

  for (const { provider, alias, first, fetchQuota, headerFor } of fallthroughCases) {
    for (const blank of [' ', '']) {
      test(provider + ' skips a ' + (blank === '' ? 'empty' : 'whitespace-only') + ' ' + first + ' and uses the token next to it', async () => {
        const authorizations: Array<string | null> = [];
        stubFetchReturning((_url, init) => {
          authorizations.push(new Headers(init?.headers).get('Authorization'));
          return Promise.resolve(mockResponse({}));
        });

        const result = await fetchQuota({ readAuth: () => ({ [alias]: { [first]: blank, token: 'real-token' } }) });
        assert.equal(result.configured, true, provider + ' fetch must read as configured');
        assert.ok(authorizations.length >= 1, provider + ' must send a request');
        for (const authorization of authorizations) {
          assert.equal(authorization, headerFor('real-token'), provider + ' must send the second field');
        }
      });
    }

    test(provider + ' with both fields blank is not configured and sends nothing', async () => {
      let fetchCalls = 0;
      stubFetchReturning(() => { fetchCalls += 1; return Promise.resolve(mockResponse({})); });

      const result = await fetchQuota({ readAuth: () => ({ [alias]: { [first]: ' ', token: ' ' } }) });
      assert.equal(result.configured, false, provider + ' fetch must read as not configured');
      assert.equal(fetchCalls, 0, provider + ' must not send a blank bearer');
    });
  }
});

describe('Command Code quota provider (VS Code parity, #1744)', () => {
  const creditsPayload = {
    credits: { monthlyCredits: 4, purchasedCredits: 25, freeCredits: 0 },
    windowLimits: {
      fiveHour: { used: 25, cap: 100, resetAt: 1_700_000_000 },
      weekly: { used: 10, cap: 50, resetAt: 1_700_000_000_000 },
    },
  };

  test('dispatch reaches the fetcher: whoami then credits, plan windows parsed', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    stubFetchReturning((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith('/alpha/whoami')) return Promise.resolve(mockResponse({ org: { id: 'org_1' } }));
      return Promise.resolve(mockResponse(creditsPayload));
    });

    const result = await fetchQuotaForProvider('command-code');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'command-code');
    assert.equal(result.providerName, 'Command Code');
    assert.equal(result.configured, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]![0], 'https://api.commandcode.ai/alpha/whoami');
    assert.equal(calls[1]![0], 'https://api.commandcode.ai/alpha/billing/credits?orgId=org_1');
    assert.equal(new Headers(calls[0]![1]?.headers).get('Authorization'), 'Bearer test-token');
    // Monthly plan window: $10 included, 4 remaining -> 60% used.
    assert.equal(result.usage!.windows.monthly!.usedPercent, 60);
    assert.equal(result.usage!.windows.monthly!.valueLabel, '6 / 10');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 25);
    assert.equal(result.usage!.windows['5h']!.resetAt, 1_700_000_000_000);
    assert.equal(result.usage!.windows.weekly!.usedPercent, 20);
    // The top-up balance rides along as a percent-less balance window.
    assert.equal(result.usage!.windows.purchased_credits!.usedPercent, null);
    assert.equal(result.usage!.windows.purchased_credits!.valueLabel, '25');
  });

  test('lists command-code as configured from the enrolled key credential', async () => {
    const configured = await listConfiguredQuotaProviders();
    assert.equal(configured.includes('command-code'), true);
  });

  test('reports not configured without a credential', async () => {
    const result = await fetchCommandCodeQuota({
      readAuth: () => ({}),
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
  });
});

describe('Open Design quota provider (VS Code parity, #1744)', () => {
  const credentialDir = path.join(temporaryQuotaDataDirectory, 'quota');
  const credentialFile = path.join(credentialDir, 'opendesign.json');
  const usagePayload = {
    windows: [
      { durationSeconds: 18000, limitCredits: 100, remainingCredits: 40, resetsAt: '2026-11-15T00:00:00.000Z' },
      { durationSeconds: 604800, limitCredits: 500, remainingCredits: 500, resetsAt: '2026-11-20T00:00:00.000Z' },
      { durationSeconds: 3600, limitCredits: 10, remainingCredits: 5, resetsAt: '2026-11-15T00:00:00.000Z' },
    ],
  };
  const writeCredentialFile = () => {
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(credentialFile, JSON.stringify({ cookie: 'tok123', workspaceId: 'ws_1' }));
  };

  afterEach(() => {
    fs.rmSync(credentialFile, { force: true });
  });

  test('dispatch reaches the fetcher: session check then plan windows', async () => {
    writeCredentialFile();
    const calls: Array<[string, RequestInit | undefined]> = [];
    stubFetchReturning((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith('/auth/get-session')) return Promise.resolve(mockResponse({ user: { id: 'u_1' } }));
      return Promise.resolve(mockResponse(usagePayload));
    });

    const result = await fetchQuotaForProvider('opendesign');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'opendesign');
    assert.equal(result.providerName, 'Open Design');
    assert.equal(result.configured, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]![0], 'https://amr-api.open-design.ai/api/auth/get-session');
    assert.equal(calls[1]![0], 'https://amr-api.open-design.ai/api/v1/workspaces/ws_1/billing/coding-plan-usage');
    // The bare token from the store file is wrapped under its cookie name.
    assert.equal(new Headers(calls[0]![1]?.headers).get('Cookie'), 'better-auth.session_token=tok123');
    assert.equal(result.usage!.windows['5h']!.usedPercent, 60);
    assert.equal(result.usage!.windows['5h']!.valueLabel, '40 / 100 credits');
    assert.equal(result.usage!.windows['7d']!.usedPercent, 0);
    // A window of an unpublished duration is left out.
    assert.equal(Object.keys(result.usage!.windows).length, 2);
  });

  test('lists opendesign as configured when the managed credential is stored', async () => {
    writeCredentialFile();
    const configured = await listConfiguredQuotaProviders();
    assert.equal(configured.includes('opendesign'), true);
  });

  test('reports the import-required error without a stored credential', async () => {
    const result = await fetchOpenDesignQuota({
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
    assert.match(result.error!, /Import the Open Design session cookie/);
  });

  test('an expired session answers the session-expired error, never zeros', async () => {
    writeCredentialFile();
    stubFetchReturning(() => Promise.resolve(mockResponse({}, { ok: false, status: 401 })));
    const result = await fetchQuotaForProvider('opendesign');
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.error!, /session expired/);
  });
});
