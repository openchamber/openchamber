import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The instance fallback reads the merged config layers. Point the global
// config directory at a path that does not exist so the machine's own
// opencode config can never leak into these assertions; the custom layer
// is resolved from OPENCODE_CONFIG at call time.
vi.hoisted(() => {
  process.env.OPENCODE_CONFIG_DIR = 'codex-test-without-config-dir';
});

const readAuth = async () => ({ openai: { access: 'test-token' } });

import { fetchQuota } from './codex.js';

const createdConfigPaths = [];

const setMergedConfig = (config) => {
  const filePath = path.join(os.tmpdir(), `codex-config-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(filePath, JSON.stringify(config));
  vi.stubEnv('OPENCODE_CONFIG', filePath);
  createdConfigPaths.push(filePath);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const filePath of createdConfigPaths.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

const mockUsage = (rateLimit) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate_limit: rateLimit }),
  }));
};

const mockPayload = (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  }));
};

describe('Codex quota windows', () => {
  it.each([
    { balance: 62500, unlimited: false, expected: '62500' },
    { balance: '62500.00', unlimited: false, expected: '62500' },
    { balance: 12.3456, unlimited: false, expected: '12.3456' },
    { balance: '12.3456', unlimited: false, expected: '12.3456' },
    { balance: 0, unlimited: false, expected: '0' },
    { balance: null, unlimited: true, expected: 'Unlimited' },
    { balance: 62500, unlimited: true, expected: 'Unlimited' },
    { balance: null, unlimited: false, expected: undefined },
    { balance: 'invalid', unlimited: false, expected: undefined },
  ])('displays credit balance $balance with unlimited=$unlimited as $expected', async ({ balance, unlimited, expected }) => {
    vi.stubGlobal('fetch', async () => Response.json({ credits: { balance, unlimited } }));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe(expected);
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
  });

  it('omits the balance window when credits are absent', async () => {
    mockUsage(null);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('labels a weekly-only primary window from its duration', async () => {
    mockUsage({
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: 1784491827,
      },
      secondary_window: null,
    });

    const result = await fetchQuota({ readAuth });

    expect(result.usage.windows.weekly.usedPercent).toBe(3);
    expect(result.usage.windows['5h']).toBeUndefined();
  });

  it('labels five-hour and weekly windows from their durations', async () => {
    mockUsage({
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    });

    const result = await fetchQuota({ readAuth });

    expect(result.usage.windows['5h'].usedPercent).toBe(10);
    expect(result.usage.windows.weekly.usedPercent).toBe(20);
  });

  it.each([
    { usedPercent: 150, expected: 100 },
    { usedPercent: -20, expected: 0 },
    { usedPercent: 200, expected: 100 },
    { usedPercent: 42, expected: 42 },
    { usedPercent: undefined, expected: null },
  ])('clamps all Codex usage windows for used_percent=$usedPercent', async ({ usedPercent, expected }) => {
    mockPayload({
      rate_limit: {
        primary_window: { used_percent: usedPercent, limit_window_seconds: 18000 },
        secondary_window: { used_percent: usedPercent, limit_window_seconds: 604800 },
      },
      spend_control: {
        individual_limit: {
          limit: '7500',
          used: '2674',
          used_percent: usedPercent,
        },
      },
    });

    const result = await fetchQuota({ readAuth });

    expect(result.usage.windows['5h'].usedPercent).toBe(expected);
    expect(result.usage.windows.weekly.usedPercent).toBe(expected);
    expect(result.usage.windows.credits.usedPercent).toBe(expected);
  });

  it('surfaces spend_control individual limit for business accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          individual_limit: {
            limit: '7500',
            used: '2674.8724080324173',
            remaining: '4825.127591967583',
            used_percent: 36,
            remaining_percent: 64
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.usedPercent).toBe(36);
    expect(result.usage.windows.credits.valueLabel).toBe('2675 / 7500 used');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not report a 401 access-enforcement rejection as an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { type: 'rejected_by_access_enforcement', code: 'no_matching_rule', message: 'Unauthorized' } }),
    }));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    // The credential is still valid; the endpoint refused usage access. Saying
    // "session expired" would send the user to re-authenticate for nothing.
    expect(result.error).not.toBe('Session expired \u2014 please re-authenticate with OpenAI');
    expect(result.error).toBe('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
  });

  it('still reports an expired session for a plain 401 without a rejection body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired \u2014 please re-authenticate with OpenAI');
  });
});

describe('Codex request deadline', () => {
  it('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Request timed out');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Codex quota instance fallback', () => {
  const instanceConfig = {
    provider: {
      'openai.main': { instanceOf: 'openai', name: 'OpenAI Main (drewrypope)' },
      'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
    },
  };

  const mockWhamByToken = () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init = {}) => ({
      ok: true,
      json: async () => ({
        email: (init.headers?.Authorization ?? '').endsWith('main-token') ? 'drewrypope@gmail.com' : 'popesdrew@gmail.com',
        rate_limit: {
          primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 1793513510 },
          secondary_window: null,
        },
      }),
    })));
  };

  it('fetches with the first usable instance credential when the bare integration is empty', async () => {
    setMergedConfig(instanceConfig);
    mockWhamByToken();
    const result = await fetchQuota({
      readAuth: async () => ({
        'openai.main': { access: 'main-token', accountId: 'acc_main' },
        'openai.alternate': { access: 'alt-token', accountId: 'acc_alt' },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.accountLabel).toBe('drewrypope@gmail.com');
    expect(result.usage.windows.weekly.usedPercent).toBe(8);
  });

  it('prefers the bare integration entry over instance credentials', async () => {
    setMergedConfig(instanceConfig);
    mockWhamByToken();
    const result = await fetchQuota({
      readAuth: async () => ({
        openai: { access: 'alt-token', accountId: 'acc_alt' },
        'openai.main': { access: 'main-token', accountId: 'acc_main' },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.accountLabel).toBe('popesdrew@gmail.com');
  });

  it('still answers Not configured when no instance holds a credential', async () => {
    setMergedConfig(instanceConfig);
    const result = await fetchQuota({ readAuth: async () => ({}) });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });
});
