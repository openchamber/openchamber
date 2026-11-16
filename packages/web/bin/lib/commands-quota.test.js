import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { configureOpenCodeCredentials, readLocalOpenCodeCredentials } from '../../server/lib/opencode/auth.js';
import {
  createQuotaCommand,
  formatQuotaResultLines,
  formatQuotaQuietLine,
  resolveQuotaTimeoutMs,
} from './commands-quota.js';
import { EXIT_CODE } from './cli-errors.js';

const codexResult = {
  providerId: 'codex',
  providerName: 'Codex',
  ok: true,
  configured: true,
  usage: {
    windows: {
      weekly: {
        usedPercent: 7,
        remainingPercent: 93,
        windowSeconds: 604800,
        resetAt: 1793513510000,
        resetAtFormatted: 'Sat, Oct 31, 7:00 PM',
      },
      credits_balance: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        valueLabel: '0',
      },
    },
  },
  fetchedAt: 1792938209143,
};

const claudeResult = {
  providerId: 'claude',
  providerName: 'Claude',
  ok: false,
  configured: true,
  usage: null,
  error: 'Session expired',
  fetchedAt: 1792938209143,
};

const captureStdout = () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = vi.fn((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
};

const fakeCatalogue = [
  { id: 'codex', name: 'Codex', aliases: ['openai', 'codex', 'chatgpt'], disabled: false },
  { id: 'claude', name: 'Claude', aliases: ['anthropic', 'claude'], disabled: false },
  { id: 'github-copilot', name: 'GitHub Copilot', aliases: ['github-copilot', 'copilot'], disabled: false },
  { id: 'openrouter', name: 'OpenRouter', aliases: ['openrouter'], disabled: true },
];

const createFakeRuntime = ({
  configured = [],
  results = {},
  catalogue = fakeCatalogue,
  storeListError = null,
  fetchDelays = {},
} = {}) => {
  const calls = { fetch: [], list: [] };
  const flight = { inFlight: 0, maxInFlight: 0 };
  let activeSource = null;
  const localSource = {
    list: async () => {
      if (storeListError) throw storeListError;
      return [];
    },
  };
  const runtime = {
    configureOpenCodeCredentials: vi.fn((source) => {
      activeSource = source;
    }),
    openCodeLocalCredentialSource: vi.fn(() => localSource),
    listQuotaProviderCatalogue: vi.fn(async () => catalogue),
    listConfiguredQuotaProviders: vi.fn(async (options) => {
      calls.list.push(options);
      await activeSource.list();
      return configured;
    }),
    fetchQuotaForProviderInstances: vi.fn(async (id) => {
      calls.fetch.push(id);
      flight.inFlight += 1;
      flight.maxInFlight = Math.max(flight.maxInFlight, flight.inFlight);
      try {
        const delay = fetchDelays[id] ?? 0;
        if (delay > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });
        }
        const entry = results[id];
        if (Array.isArray(entry)) return entry;
        return [entry ?? {
          providerId: id,
          providerName: id,
          ok: false,
          configured: false,
          usage: null,
          error: 'Unsupported provider',
          fetchedAt: 0,
        }];
      } finally {
        flight.inFlight -= 1;
      }
    }),
  };
  return { runtime, calls, flight, localSource };
};

const codexLegacyResult = {
  ...codexResult,
  credentialId: 'cred_legacy',
  credentialLabel: 'OAuth',
  credentialActive: false,
  accountLabel: 'drewrypope@gmail.com',
};

const codexSharingResult = {
  providerId: 'codex',
  providerName: 'Codex',
  ok: false,
  configured: true,
  usage: null,
  error: 'OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage; this sign-in method has no usage endpoint.',
  fetchedAt: 1792938209143,
  credentialId: 'cred_sharing',
  credentialLabel: 'OpenAI 2',
  credentialActive: true,
};

const createCommand = (runtime, env = {}) => createQuotaCommand({
  loadQuotaRuntime: async () => runtime,
  env,
});

describe('quota formatting', () => {
  it('formats a successful result with its windows', () => {
    expect(formatQuotaResultLines(codexResult)).toEqual([
      'Codex (codex)',
      '  weekly: 7% used, resets Sat, Oct 31, 7:00 PM',
      '  credits_balance: 0',
    ]);
  });

  it('labels a result with its credential and account', () => {
    expect(formatQuotaResultLines(codexLegacyResult)[0]).toBe('Codex (codex) — OAuth — drewrypope@gmail.com');
    expect(formatQuotaResultLines(codexSharingResult)[0]).toContain('Codex (codex) — OpenAI 2:');
    expect(formatQuotaQuietLine(codexLegacyResult)).toBe('codex/OAuth weekly:7% credits_balance:0');
    expect(formatQuotaQuietLine(codexSharingResult)).toBe('codex/OpenAI-2 error');
  });

  it('prints the per-model breakdown under the windows', () => {
    const withModels = {
      providerId: 'opendesign',
      providerName: 'Open Design',
      ok: true,
      configured: true,
      usage: {
        windows: {
          '7d': { usedPercent: 15, resetAtFormatted: 'Sat, Nov 1, 7:00 PM' },
        },
        models: [
          { model: 'claude-haiku', credits: 4.5, sharePercent: 75, totalTokens: 2250, multiplier: 2 },
          { model: 'deepseek-v4-flash', credits: 1.5, sharePercent: 25, totalTokens: 3000, multiplier: 1 },
        ],
      },
      fetchedAt: 0,
    };
    expect(formatQuotaResultLines(withModels)).toEqual([
      'Open Design (opendesign)',
      '  7d: 15% used, resets Sat, Nov 1, 7:00 PM',
      '  models:',
      '    claude-haiku: 4.5 credits, 75% share, 2250 tokens, 2x multiplier',
      '    deepseek-v4-flash: 1.5 credits, 25% share, 3000 tokens, 1x multiplier',
    ]);
    // Quiet mode stays one line and leaves the breakdown out.
    expect(formatQuotaQuietLine(withModels)).toBe('opendesign 7d:15%');
  });

  it('formats a failed result as one line with the error', () => {
    expect(formatQuotaResultLines(claudeResult)).toEqual(['Claude (claude): Session expired']);
  });

  it('formats quiet lines as compact tokens', () => {
    expect(formatQuotaQuietLine(codexResult)).toBe('codex weekly:7% credits_balance:0');
    expect(formatQuotaQuietLine(claudeResult)).toBe('claude error');
  });
});

describe('quota command', () => {
  it('wires the direct local credential-store source before fetching', async () => {
    const { runtime, localSource } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({}, 'codex');
    } finally {
      out.restore();
    }

    // The single source (code#2490, #2282): the direct store read,
    // wired as-is — no server source is composed in front of it.
    expect(runtime.openCodeLocalCredentialSource).toHaveBeenCalledTimes(1);
    expect(runtime.configureOpenCodeCredentials).toHaveBeenCalledTimes(1);
    expect(runtime.configureOpenCodeCredentials).toHaveBeenCalledWith(localSource);
    expect(out.text()).toContain('weekly: 7% used');
  });

  it('prints every configured provider and keeps a failure inline', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude'],
      results: { codex: codexResult, claude: claudeResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({}, null);
    } finally {
      out.restore();
    }

    expect(calls.fetch).toEqual(['codex', 'claude']);
    expect(out.text()).toContain('Codex (codex)');
    expect(out.text()).toContain('Claude (claude): Session expired');
  });

  it('asks the listing to include disabled providers only with --all', async () => {
    const { runtime, calls } = createFakeRuntime({ configured: [] });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({}, null);
      await quotaCommand({ all: true }, null);
    } finally {
      out.restore();
    }

    expect(calls.list).toEqual([{ includeDisabled: false }, { includeDisabled: true }]);
  });

  it('prints one labeled block per credential of a provider', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: [codexLegacyResult, codexSharingResult] },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand({}, 'codex');
      // One credential read fine, so the request as a whole succeeded.
      expect(process.exitCode ?? 0).toBe(previousExitCode ?? 0);
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }

    expect(out.text()).toContain('Codex (codex) — OAuth — drewrypope@gmail.com');
    expect(out.text()).toContain('weekly: 7% used');
    expect(out.text()).toContain('Codex (codex) — OpenAI 2:');
  });

  it('prints one quiet line per credential of a provider', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: [codexLegacyResult, codexSharingResult] },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ quiet: true }, 'codex');
    } finally {
      out.restore();
    }

    expect(out.text()).toBe('codex/OAuth weekly:7% credits_balance:0\ncodex/OpenAI-2 error\n');
  });

  it('emits JSON only in json mode', async () => {
    const { runtime } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ json: true }, 'codex');
    } finally {
      out.restore();
    }

    const payload = JSON.parse(out.text());
    expect(payload.providers).toEqual([{
      ...codexResult,
      elapsedMs: expect.any(Number),
      credentialSource: 'local',
    }]);
  });

  it('emits one compact line per provider in quiet mode', async () => {
    const { runtime } = createFakeRuntime({
      configured: ['codex', 'claude'],
      results: { codex: codexResult, claude: claudeResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ quiet: true }, null);
    } finally {
      out.restore();
    }

    expect(out.text()).toBe('codex weekly:7% credits_balance:0\nclaude error\n');
  });

  it('sets a non-zero exit code when the one requested provider fails', async () => {
    const { runtime } = createFakeRuntime({ results: { claude: claudeResult } });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand({}, 'claude');
      expect(process.exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
      expect(out.text()).toContain('Session expired');
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('rejects an unknown provider as a usage error', async () => {
    const { runtime } = createFakeRuntime();
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, 'nope')).rejects.toThrow("Unknown quota provider 'nope'.");
  });

  it('prints its own help for the help action without loading the runtime', async () => {
    const loadQuotaRuntime = vi.fn(async () => {
      throw new Error('should not load');
    });
    const quotaCommand = createQuotaCommand({ loadQuotaRuntime, env: {} });
    const out = captureStdout();
    try {
      await quotaCommand({}, 'help');
    } finally {
      out.restore();
    }
    expect(loadQuotaRuntime).not.toHaveBeenCalled();
    expect(out.text()).toContain('openchamber quota [PROVIDER');
    expect(out.text()).toContain('credential store');
    expect(out.text()).not.toContain('OPENCODE_HOST');
  });
});

describe('quota provider arguments', () => {
  const openrouterResult = {
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    ok: true,
    configured: true,
    usage: { windows: { monthly: { usedPercent: 100, resetAtFormatted: 'Sat, Oct 31, 7:00 PM' } } },
    fetchedAt: 0,
  };
  const copilotResult = {
    providerId: 'github-copilot',
    providerName: 'GitHub Copilot',
    ok: true,
    configured: true,
    usage: { windows: { premium_interactions: { valueLabel: 'Unlimited' } } },
    fetchedAt: 0,
  };

  const runCommand = async (runtime, options, args) => {
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand(options, args);
      return { text: out.text(), exitCode: process.exitCode ?? 0 };
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
  };

  it('fetches several providers in argument order', async () => {
    const { runtime, calls } = createFakeRuntime({
      results: { codex: codexResult, claude: claudeResult },
    });
    const { text, exitCode } = await runCommand(runtime, {}, ['claude', 'codex']);
    expect(calls.fetch).toEqual(['claude', 'codex']);
    expect(text.indexOf('Claude (claude)')).toBeLessThan(text.indexOf('Codex (codex)'));
    // Claude returned no successful result, so the run reports failure.
    expect(exitCode).toBe(EXIT_CODE.GENERAL_ERROR);
  });

  it('resolves display names and credential aliases, ignoring case', async () => {
    const { runtime, calls } = createFakeRuntime({
      results: { codex: codexResult, 'github-copilot': copilotResult },
    });
    await runCommand(runtime, {}, ['CHATGPT']);
    await runCommand(runtime, {}, ['GitHub Copilot']);
    expect(calls.fetch).toEqual(['codex', 'github-copilot']);
  });

  it('fetches a provider once when several arguments name it', async () => {
    const { runtime, calls } = createFakeRuntime({ results: { codex: codexResult } });
    await runCommand(runtime, {}, ['codex', 'chatgpt', 'Codex']);
    expect(calls.fetch).toEqual(['codex']);
  });

  it('fetches a turned off provider that is named exactly', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: [],
      results: { openrouter: openrouterResult },
    });
    const { text } = await runCommand(runtime, {}, ['openrouter']);
    expect(calls.fetch).toEqual(['openrouter']);
    expect(text).toContain('OpenRouter (openrouter)');
  });

  it('expands a wildcard over configured providers, leaving out turned off ones', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude', 'openrouter'],
      results: { codex: codexResult, claude: claudeResult, openrouter: openrouterResult },
    });
    await runCommand(runtime, {}, ['*']);
    expect(calls.fetch).toEqual(['codex', 'claude']);
  });

  it('includes turned off providers in a wildcard expansion only with --all', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['codex', 'claude', 'openrouter'],
      results: { codex: codexResult, claude: claudeResult, openrouter: openrouterResult },
    });
    await runCommand(runtime, { all: true }, ['*']);
    expect(calls.fetch).toEqual(['codex', 'claude', 'openrouter']);
  });

  it('rejects a wildcard that matches only a turned off provider', async () => {
    const { runtime, calls } = createFakeRuntime({
      configured: ['openrouter'],
      results: { openrouter: openrouterResult },
    });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['open*'])).rejects.toThrow("No configured quota provider matches 'open*'.");
    expect(calls.fetch).toEqual([]);
  });

  it('rejects a wildcard that matches no configured provider', async () => {
    const { runtime, calls } = createFakeRuntime({ configured: ['codex'], results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['git*'])).rejects.toThrow("No configured quota provider matches 'git*'.");
    expect(calls.fetch).toEqual([]);
  });

  it('rejects an unknown argument before fetching anything', async () => {
    const { runtime, calls } = createFakeRuntime({ results: { codex: codexResult } });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, ['codex', 'nope'])).rejects.toThrow("Unknown quota provider 'nope'.");
    expect(calls.fetch).toEqual([]);
  });

  it('keeps the json shape a flat list in argument order', async () => {
    const { runtime } = createFakeRuntime({
      results: { codex: codexResult, 'github-copilot': copilotResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ json: true }, ['copilot', 'codex']);
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.text());
    expect(payload.providers.map((entry) => entry.providerId)).toEqual(['github-copilot', 'codex']);
  });
});

const captureStderr = () => {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = vi.fn((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
};

describe('direct local-store read (readLocalOpenCodeCredentials)', () => {
  it('lets the direct local-store read resolve the store the server was launched with', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-managed-test-'));
    try {
      const dataHome = path.join(root, 'data');
      const dbPath = path.join(dataHome, 'opencode', 'opencode.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec(`create table credential (
        id text primary key,
        integration_id text,
        label text not null,
        value text not null,
        connector_id text,
        method_id text,
        active integer,
        time_created integer not null,
        time_updated integer not null
      )`);
      db.prepare('insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)')
        .run('cred_google', 'google', 'default', JSON.stringify({ type: 'key', key: 'managed-store-key' }), 1, 100, 100);
      db.close();
      // The wired source is the running server OpenChamber launched, so
      // the launch environment is the one the server resolves its store
      // from and the direct read may use it.
      const primary = {
        list: vi.fn(async () => []),
        usesLocalStore: () => true,
        getLaunchEnvironment: () => ({ HOME: root, XDG_DATA_HOME: dataHome }),
      };
      configureOpenCodeCredentials(primary);
      await expect(readLocalOpenCodeCredentials()).resolves.toEqual({
        google: { type: 'api', key: 'managed-store-key' },
      });
    } finally {
      configureOpenCodeCredentials(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the wired source establishes no launch environment', async () => {
    // readLocalOpenCodeCredentials resolves the store from the wired
    // source's launch environment and refuses without one: a source
    // with no environment to forward cannot establish which store the
    // connected OpenCode uses, and no other environment may be
    // substituted for it.
    const primary = {
      list: vi.fn(async () => []),
      usesLocalStore: () => true,
      getLaunchEnvironment: () => null,
    };
    configureOpenCodeCredentials(primary);
    try {
      await expect(readLocalOpenCodeCredentials()).rejects.toThrow(/store location is unknown/);
    } finally {
      configureOpenCodeCredentials(null);
    }
  });
});

describe('quota command credential store failures', () => {
  it('fails the run with the store error when the store cannot be read', async () => {
    // There is no second source to fall back to: the direct store
    // read is the single source, so its failure is the run's failure.
    const storeError = new Error('store missing');
    const { runtime } = createFakeRuntime({ storeListError: storeError });
    const quotaCommand = createCommand(runtime);
    await expect(quotaCommand({}, null)).rejects.toBe(storeError);
  });

  it('stamps every result as a local store read, with no stderr note', async () => {
    const { runtime } = createFakeRuntime({
      configured: ['codex'],
      results: { codex: codexResult },
    });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    const err = captureStderr();
    let payload;
    try {
      await quotaCommand({ json: true }, null);
      payload = JSON.parse(out.text());
      await quotaCommand({}, null);
    } finally {
      out.restore();
      err.restore();
    }
    expect(payload.providers[0]).toMatchObject({ providerId: 'codex', ok: true, credentialSource: 'local' });
    expect(out.text()).toContain('Codex (codex)');
    // Every read is a store read by design now, so there is no
    // fallback note to print; the help text names the source instead.
    expect(err.text()).toBe('');
  });
});

describe('quota fetch timeout and concurrency', () => {
  it('parses the timeout from the environment with a sane default', () => {
    expect(resolveQuotaTimeoutMs({})).toBe(10_000);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '250' })).toBe(250);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '0' })).toBe(10_000);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '-5' })).toBe(10_000);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: 'nope' })).toBe(10_000);
    for (const spelling of ['1e3', '10000junk', '10.9', '250ms', '0x10']) {
      expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: spelling })).toBe(10_000);
    }
    // Magnitudes no JS timer can honour fall back instead of overflowing
    // setTimeout to ~1 ms; the largest honourable value is accepted.
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '2147483647' })).toBe(2_147_483_647);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '3000000000' })).toBe(10_000);
    expect(resolveQuotaTimeoutMs({ OPENCHAMBER_QUOTA_TIMEOUT_MS: '9007199254740993' })).toBe(10_000);
  });

  it('answers a timeout row for a slow provider and keeps the rest of the batch', async () => {
    const catalogue = [
      ...fakeCatalogue,
      { id: 'slow', name: 'Slow Provider', aliases: ['slow'], disabled: false },
    ];
    const { runtime } = createFakeRuntime({
      catalogue,
      results: { codex: codexResult, slow: { ...codexResult, providerId: 'slow', providerName: 'Slow Provider' } },
      fetchDelays: { slow: 200 },
    });
    const quotaCommand = createCommand(runtime, { OPENCHAMBER_QUOTA_TIMEOUT_MS: '25' });
    const out = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await quotaCommand({ json: true }, ['codex', 'slow']);
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
    const payload = JSON.parse(out.text());
    expect(payload.providers.map((entry) => entry.providerId)).toEqual(['codex', 'slow']);
    expect(payload.providers[0]).toMatchObject({ ok: true, credentialSource: 'local' });
    expect(payload.providers[0].elapsedMs).toEqual(expect.any(Number));
    const slow = payload.providers[1];
    expect(slow).toMatchObject({ providerId: 'slow', providerName: 'Slow Provider', ok: false, status: 'timeout' });
    expect(slow.error).toContain('timed out after 25 ms');
    expect(slow.elapsedMs).toBeLessThan(200);
  });

  it('fetches configured providers in parallel and keeps listing order', async () => {
    const configured = ['codex', 'claude', 'deepseek', 'wafer', 'kilo'];
    const fetchDelays = Object.fromEntries(configured.map((id) => [id, 50]));
    const { runtime, flight } = createFakeRuntime({ configured, fetchDelays });
    const quotaCommand = createCommand(runtime);
    const out = captureStdout();
    try {
      await quotaCommand({ json: true }, null);
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.text());
    expect(payload.providers.map((entry) => entry.providerId)).toEqual(configured);
    expect(flight.maxInFlight).toBeGreaterThanOrEqual(3);
    expect(flight.maxInFlight).toBeLessThanOrEqual(6);
  });
});
