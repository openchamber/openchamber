import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
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

let codexHome;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const filePath of createdConfigPaths.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }

  delete process.env.CODEX_HOME;
  fs.rmSync(codexHome, { recursive: true, force: true });
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

const realTimeout = AbortSignal.timeout.bind(AbortSignal);

// Settles only when the request's deadline fires, the way a stalled connection does.
const untilDeadline = (signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason));
});

// Headers arrive, then the body never does.
const stalledBody = (status, signal) => ({ ok: status === 200, status, json: () => untilDeadline(signal) });

describe('Codex quota windows', () => {
  it.each([
    ['usd', 'usage', '$8.10 / $150.00'],
    ['credits', 'credits', '8 / 150 used'],
    [undefined, 'credits', '8 / 150 used'],
  ])('formats the individual allowance for unit %s', async (unit, key, label) => {
    vi.stubGlobal('fetch', async () => Response.json({
      spend_control: { individual_limit: { unit, used: '8.104', limit: '150', used_percent: 5 } },
    }));

    const result = await fetchQuota({ readAuth });

    expect(result.usage.windows[key]?.valueLabel).toBe(label);
    expect(result.usage.windows[key]?.usedPercent).toBe(5);
    expect(Object.keys(result.usage.windows)).toEqual([key]);
  });

  it.each([
    { balance: 62500, unlimited: false, expected: '62,500' },
    { balance: '62500.00', unlimited: false, expected: '62,500' },
    { balance: 12.3456, unlimited: false, expected: '12.3' },
    { balance: '12.3456', unlimited: false, expected: '12.3' },
    { balance: 38538.5254395, unlimited: false, expected: '38,538.5' },
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

  it('gives up on a usage request OpenAI never answers', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })));

    try {
      const result = await fetchQuota({ readAuth });

      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.error).toBe('Request timed out');
    } finally {
      timeout.mockRestore();
    }
  });

  it('reports a 401 whose body never arrives as a timeout, not an expired session', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => stalledBody(401, init.signal)));

    try {
      const result = await fetchQuota({ readAuth });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Request timed out');
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('Codex usage through the Codex CLI sign-in', () => {
  const REFUSED = { error: { type: 'rejected_by_access_enforcement', code: 'no_matching_rule' } };
  const CLI_USAGE = { email: 'cli@example.com', rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } } };
  const tokenWithEmail = (email) => `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email } })).toString('base64url')}.s`;

  const signInCli = () => fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'cli-token', refresh_token: 'cli-refresh', account_id: 'acct_cli' } }),
  );

  // The usage endpoint refuses OpenCode's token and accepts the CLI's.
  const stubUsageEndpoint = (cliStatus = 200) => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (init.headers.Authorization !== 'Bearer cli-token') return Response.json(REFUSED, { status: 401 });
      return Response.json(cliStatus === 200 ? CLI_USAGE : { error: { type: 'invalid_jwt' } }, { status: cliStatus });
    }));
    return calls;
  };

  it('reads the numbers with the CLI sign-in and names its account', async () => {
    signInCli();
    const calls = stubUsageEndpoint();

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(42);
    expect(result.accountLabel).toBe('cli@example.com');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(calls[1].headers['ChatGPT-Account-Id']).toBe('acct_cli');
  });

  it('names the account from the CLI token when the answer carries no email', async () => {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: tokenWithEmail('cli@example.com') } }));
    vi.stubGlobal('fetch', vi.fn(async (url, init) => init.headers.Authorization === 'Bearer test-token'
      ? Response.json(REFUSED, { status: 401 })
      : Response.json({ rate_limit: CLI_USAGE.rate_limit })));

    expect((await fetchQuota({ readAuth })).accountLabel).toBe('cli@example.com');
  });

  it('keeps the usage-page message when the CLI request fails', async () => {
    signInCli();
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init.headers.Authorization === 'Bearer test-token') return Response.json(REFUSED, { status: 401 });
      throw new Error('fetch failed');
    }));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
  });

  it.each([
    ['before headers', (signal) => untilDeadline(signal)],
    ['after headers', (signal) => Promise.resolve(stalledBody(200, signal))],
  ])('reports a CLI request that stalls %s as a timeout', async (_when, stall) => {
    signInCli();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
    vi.stubGlobal('fetch', vi.fn(async (url, init) => init.headers.Authorization === 'Bearer test-token'
      ? Response.json(REFUSED, { status: 401 })
      : stall(init.signal)));

    try {
      const result = await fetchQuota({ readAuth });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Request timed out');
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps the usage-page message without a CLI sign-in', async () => {
    const calls = stubUsageEndpoint();

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
    expect(calls).toHaveLength(1);
  });

  it('keeps the usage-page message when the endpoint refuses the CLI token too', async () => {
    signInCli();
    stubUsageEndpoint(401);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
  });

  it('never consults the CLI for a legacy sign-in', async () => {
    signInCli();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push(init.headers.Authorization);
      return Response.json({ rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 } } });
    }));

    const result = await fetchQuota({ readAuth });

    expect(result.usage.windows['5h'].usedPercent).toBe(7);
    expect(result.accountLabel).toBeUndefined();
    expect(calls).toEqual(['Bearer test-token']);
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
