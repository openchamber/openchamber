import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const authState = vi.hoisted(() => ({ projected: {}, rows: [], readError: null, rowsError: null }));

// Dependency seam: the registry's credential reads are injected per call.
const authDeps = {
  readAuth: async () => {
    if (authState.readError) throw authState.readError;
    return authState.projected;
  },
  listCredentials: async (integrationID) => {
    if (authState.rowsError) throw authState.rowsError;
    return integrationID
      ? authState.rows.filter((row) => row.integrationID === integrationID)
      : authState.rows;
  },
};

// The registry reads disabled_providers and provider instances through the
// real config-layer reader. Point its global config directory at a path that
// does not exist so the machine's own opencode.json can never leak into these
// assertions; the custom layer is resolved from OPENCODE_CONFIG at call time,
// so each test writes the config it needs to a fresh file.
vi.hoisted(() => {
  process.env.OPENCODE_CONFIG_DIR = 'quota-providers-test-without-config-dir';
});

import * as google from './google/index.js';
import { OpenCodeUpstreamAuthError } from '../../opencode/credential-auth-error.js';
import { fetchQuotaForProvider, fetchQuotaForProviderInstances, listConfiguredQuotaProviders, listQuotaProviderCatalogue } from './index.js';

const createdConfigPaths = [];

const setMergedConfig = (config) => {
  const filePath = path.join(os.tmpdir(), `quota-providers-config-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(filePath, JSON.stringify(config));
  vi.stubEnv('OPENCODE_CONFIG', filePath);
  createdConfigPaths.push(filePath);
};

const whamPayload = (email, usedPercent) => ({
  email,
  account_id: 'acc',
  plan_type: 'prolite',
  rate_limit: {
    primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1793513510 },
    secondary_window: null,
  },
  credits: { balance: '0', unlimited: false },
});

const fakeFetch = async (url, init = {}) => {
  const authorization = init.headers?.Authorization ?? '';
  if (String(url).includes('chatgpt.com')) {
    if (authorization === 'Bearer legacy-token') {
      return { ok: true, status: 200, json: async () => whamPayload('drewrypope@gmail.com', 8) };
    }
    if (authorization === 'Bearer alt-token') {
      return { ok: true, status: 200, json: async () => whamPayload('popesdrew@gmail.com', 12) };
    }
    return { ok: false, status: 401, json: async () => ({ error: { type: 'rejected_by_access_enforcement' } }) };
  }
  if (String(url).includes('opencode.ai/console/api/billing/status')) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (String(url).includes('opencode.ai/console/api/go/status')) {
    const orgID = init.headers?.['x-org-id'] ?? '';
    if (orgID === 'org_BROKEN12') {
      return { ok: true, status: 200, json: async () => ({ product: 'free', access: { meters: {} } }) };
    }
    const usedMicroCents = orgID === 'org_SECOND123' ? '900' : '250';
    return {
      ok: true,
      status: 200,
      json: async () => ({
        product: 'go',
        access: { meters: { fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents } } },
      }),
    };
  }
  if (String(url).includes('opencode.ai/zen/go/v1/usage')) {
    return { ok: true, status: 200, json: async () => ({ usage: { rolling: { percent: 42, resetsAt: '2026-08-12T12:00:00.000Z' } } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};

const oauthRow = (integrationID, { id, label, active, access, accountId }) => {
  const value = { type: 'oauth', access, refresh: 'rt', expires: 1 };
  if (accountId) value.accountId = accountId;
  return { id, integrationID, label, active, value };
};

const legacyRow = oauthRow('openai', { id: 'cred_legacy', label: 'OAuth', active: false, access: 'legacy-token', accountId: 'acc_main' });
const sharingRow = oauthRow('openai', { id: 'cred_sharing', label: 'OpenAI 2', active: true, access: 'sharing-token' });

beforeEach(() => {
  authState.projected = {};
  authState.rows = [];
  authState.readError = null;
  authState.rowsError = null;
  setMergedConfig({});
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const filePath of createdConfigPaths.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google (Code Assist, per-model)');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', async () => {
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.toBeInstanceOf(Array);
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider', authDeps);
    const second = fetchQuotaForProvider('unsupported-test-provider', authDeps);

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider', authDeps)).not.toBe(first);
  });

  it('releases the coalescing entry once a timed-out provider settles', async () => {
    authState.projected = { 'github-copilot': { type: 'oauth', access: 'gh-token' } };
    const nativeTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(1));
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })));

    const timedOut = await fetchQuotaForProvider('github-copilot', authDeps);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe('Request timed out');

    // The deadline settles the promise, so its .finally releases the entry and
    // the next request fetches again instead of reusing the dead promise.
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 80 } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const fresh = await fetchQuotaForProvider('github-copilot', authDeps);
    expect(fresh.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('shared upstream auth failure (#894)', () => {
  it('marks a single-provider result whose credential read OpenCode rejected', async () => {
    authState.readError = new OpenCodeUpstreamAuthError('Authentication required');
    const result = await fetchQuotaForProvider('openrouter', authDeps);
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe('Authentication required');
    expect(result.error).toContain('OpenCode upstream authentication failed');
    expect(result.errorKind).toBe('opencode_upstream_auth');
  });
  it('classifies the xAI result from its credential-read marker, not its text', async () => {
    authState.readError = new Error('Authentication required');
    const result = await fetchQuotaForProvider('xai');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('OpenCode upstream authentication failed');
    expect(result.errorKind).toBe('opencode_upstream_auth');
    // The marker is an internal signal; it never reaches consumers.
    expect(result.credentialReadFailure).toBeUndefined();
  });

  it('answers one marked row when the credential-store read itself is rejected', async () => {
    authState.rowsError = new OpenCodeUpstreamAuthError('Authentication required');
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('OpenCode upstream authentication failed');
    expect(results[0].errorKind).toBe('opencode_upstream_auth');
  });

  it('names the shared path when the configured-provider listing cannot read credentials', async () => {
    authState.readError = new OpenCodeUpstreamAuthError('Authentication required');
    await expect(listConfiguredQuotaProviders({}, authDeps)).rejects.toThrow('OpenCode upstream authentication failed');
  });

  it('names the shared path when an instance credential read in the listing is rejected', async () => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    authState.rowsError = new OpenCodeUpstreamAuthError('Authentication required');
    await expect(listConfiguredQuotaProviders({}, authDeps)).rejects.toThrow('OpenCode upstream authentication failed');
  });

  it('rethrows a non-auth instance credential read failure in the listing unchanged', async () => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    authState.rowsError = new Error('credential store exploded');
    await expect(listConfiguredQuotaProviders({}, authDeps)).rejects.toThrow('credential store exploded');
  });

  it('leaves a provider-specific failure untouched', async () => {
    authState.readError = new Error('Request failed');
    const result = await fetchQuotaForProvider('openrouter', authDeps);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request failed');
    expect(result.errorKind).toBeUndefined();
  });

  // #1129: a provider's own API can reject its credential with the shared
  // path's exact words. Provenance, not text, decides the classification.
  it('leaves a provider error worded exactly like the shared failure untouched', async () => {
    authState.readError = new Error('Authentication required');
    const result = await fetchQuotaForProvider('openrouter', authDeps);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Authentication required');
    expect(result.errorKind).toBeUndefined();
  });

  it('passes a z.ai payload.msg of Authentication required through unchanged', async () => {
    authState.projected = { 'zai-coding-plan': { type: 'api', key: 'zai-key' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      code: 1001,
      msg: 'Authentication required',
      success: false,
    })));

    const result = await fetchQuotaForProvider('zai-coding-plan', authDeps);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Authentication required');
    expect(result.errorKind).toBeUndefined();
  });
});

describe('disabled providers', () => {
  beforeEach(() => {
    authState.projected = {
      openrouter: { type: 'api', key: 'or-key' },
      'github-copilot': { type: 'oauth', access: 'gh-token' },
      openai: { type: 'oauth', access: 'sharing-token' },
    };
    setMergedConfig({ disabled_providers: ['openrouter', 'github-copilot'] });
  });

  it('leaves disabled providers out of the listing by default', async () => {
    const configured = await listConfiguredQuotaProviders({}, authDeps);
    expect(configured).toContain('codex');
    expect(configured).not.toContain('openrouter');
    expect(configured).not.toContain('github-copilot');
  });

  it('includes disabled providers when asked', async () => {
    const configured = await listConfiguredQuotaProviders({ includeDisabled: true }, authDeps);
    expect(configured).toContain('openrouter');
    expect(configured).toContain('github-copilot');
  });

  it('still fetches a disabled provider named explicitly', async () => {
    const result = await fetchQuotaForProvider('openrouter', authDeps);
    expect(result.providerId).toBe('openrouter');
    expect(result.error).not.toBe('Unsupported provider');

    const [instanceResult] = await fetchQuotaForProviderInstances('openrouter', authDeps);
    expect(instanceResult.providerId).toBe('openrouter');
  });
});

describe('meta provider listing', () => {
  it('lists meta once the meta credential is present', async () => {
    authState.projected = { meta: { type: 'api', key: 'LLM|test-minted-key' } };
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.toContain('meta');
  });

  it('leaves meta out without a credential', async () => {
    authState.projected = {};
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.not.toContain('meta');
  });

  it('catalogues meta under its id with the meta alias', () => {
    const meta = listQuotaProviderCatalogue().find((entry) => entry.id === 'meta');
    expect(meta?.name).toBe('Meta Model API');
    expect(meta?.aliases).toContain('meta');
    expect(meta?.disabled).toBe(false);
  });
});

describe('per-credential quota', () => {
  beforeEach(() => {
    authState.projected = { openai: sharingRow.value };
    authState.rows = [legacyRow, sharingRow];
  });

  it('returns one labeled result per stored Codex credential', async () => {
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(2);

    const [legacy, sharing] = results;
    expect(legacy.ok).toBe(true);
    expect(legacy.credentialId).toBe('cred_legacy');
    expect(legacy.credentialLabel).toBe('OAuth');
    expect(legacy.credentialActive).toBe(false);
    expect(legacy.accountLabel).toBe('drewrypope@gmail.com');
    expect(legacy.usage.windows.weekly.usedPercent).toBe(8);

    expect(sharing.ok).toBe(false);
    expect(sharing.credentialId).toBe('cred_sharing');
    expect(sharing.credentialLabel).toBe('OpenAI 2');
    expect(sharing.credentialActive).toBe(true);
    expect(sharing.error).toContain('chatgpt.com/settings/usage');
  });

  it('keeps the single-result shape when the store holds one credential', async () => {
    authState.rows = [legacyRow];
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialLabel).toBe('OAuth');
  });

  it('falls back to the active-credential fetch when the store holds no rows', async () => {
    authState.rows = [];
    authState.projected = { openai: legacyRow.value };
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialId).toBeUndefined();
  });
});

describe('per-credential quota — OpenCode Go workspaces', () => {
  const consoleRow = (id, label, active, orgID) => ({
    id,
    integrationID: 'opencode',
    label,
    active,
    value: {
      type: 'oauth',
      access: `token-${orgID}`,
      refresh: 'rt',
      expires: Date.now() + 3_600_000,
      server: 'https://opencode.ai/console',
      orgID,
    },
  });

  // The gate from #768: two stored Console rows with distinct orgIDs
  // must enumerate as two distinct usable per-workspace rows.
  it('returns one labeled row per stored Console workspace and skips unusable rows', async () => {
    authState.rows = [
      consoleRow('cred_ws1', 'Workspace One', true, 'org_FIRST123'),
      consoleRow('cred_ws2', undefined, false, 'org_SECOND123'),
      // Not a Console sign-in (another server): unusable for Go, skipped.
      { id: 'cred_other', integrationID: 'opencode', label: 'Other', active: false, value: { type: 'oauth', access: 'x', refresh: 'rt', expires: 1, server: 'https://example.com/console', orgID: 'org_OTHER123' } },
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go', authDeps);
    expect(results).toHaveLength(2);

    const [first, second] = results;
    expect(first.credentialId).toBe('cred_ws1');
    expect(first.credentialLabel).toBe('Workspace One');
    expect(first.credentialActive).toBe(true);
    expect(first.accountLabel).toBe('org_FIRST123');
    expect(first.planLabel).toBe('go');
    expect(first.usage.windows['5h'].usedPercent).toBe(25);

    expect(second.credentialId).toBe('cred_ws2');
    expect(second.credentialLabel).toBeUndefined();
    expect(second.accountLabel).toBe('org_SECOND123');
    expect(second.usage.windows['5h'].usedPercent).toBe(90);
  });

  it('isolates a failing workspace row from the healthy ones', async () => {
    authState.rows = [
      consoleRow('cred_ok', 'OK', true, 'org_FIRST123'),
      consoleRow('cred_broken', 'Broken', false, 'org_BROKEN12'),
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go', authDeps);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].credentialId).toBe('cred_broken');
    expect(results[1].error).toMatch(/subscription/i);
  });

  it('falls back to the single combined row when the store holds no usable rows', async () => {
    authState.rows = [];
    authState.projected = { opencode: consoleRow('cred_active', 'Active', true, 'org_FIRST123').value };
    const results = await fetchQuotaForProviderInstances('opencode-go', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialId).toBeUndefined();
    expect(results[0].usage.windows['5h'].usedPercent).toBe(25);
  });

  it('puts the Console row before the API-key row when both credential types are stored', async () => {
    authState.rows = [
      { id: 'cred_key', integrationID: 'opencode-go', label: 'API Key', active: true, value: { type: 'api', key: 'go-key' } },
      consoleRow('cred_ws1', 'Workspace One', true, 'org_FIRST123'),
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go', authDeps);
    expect(results).toHaveLength(2);

    const [primary, keyRow] = results;
    expect(primary.credentialId).toBe('cred_ws1');
    expect(primary.credentialActive).toBe(true);
    expect(primary.accountLabel).toBe('org_FIRST123');
    expect(primary.ok).toBe(true);

    expect(keyRow.credentialId).toBe('cred_key');
    expect(keyRow.credentialLabel).toBe('API Key');
    expect(keyRow.credentialActive).toBe(true);
    expect(keyRow.ok).toBe(true);
    expect(keyRow.usage.windows['5h'].usedPercent).toBe(42);
  });

  it('catalogues opencode-go with the shared opencode credential alias', () => {
    const entry = listQuotaProviderCatalogue().find((candidate) => candidate.id === 'opencode-go');
    expect(entry?.aliases).toEqual(expect.arrayContaining(['opencode-go', 'opencode']));
  });
});

describe('provider instances', () => {
  beforeEach(() => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    authState.rows = [
      oauthRow('openai.alternate', { id: 'cred_alt', label: 'OAuth', active: true, access: 'alt-token', accountId: 'acc_alt' }),
    ];
  });

  it('lists an instance that has a usable credential', async () => {
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.toContain('openai.alternate');
  });

  it('fetches an instance as its own labeled row', async () => {
    const results = await fetchQuotaForProviderInstances('openai.alternate', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].providerId).toBe('openai.alternate');
    expect(results[0].providerName).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(results[0].accountLabel).toBe('popesdrew@gmail.com');
    expect(results[0].usage.windows.weekly.usedPercent).toBe(12);

    const single = await fetchQuotaForProvider('openai.alternate', authDeps);
    expect(single.providerId).toBe('openai.alternate');
    expect(single.ok).toBe(true);
  });

  it('leaves a disabled instance out of the listing', async () => {
    setMergedConfig({
      disabled_providers: ['openai.alternate'],
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.not.toContain('openai.alternate');
    await expect(listConfiguredQuotaProviders({ includeDisabled: true }, authDeps)).resolves.toContain('openai.alternate');
  });

  it('does not list an instance with no credential', async () => {
    authState.rows = [];
    await expect(listConfiguredQuotaProviders({}, authDeps)).resolves.not.toContain('openai.alternate');
  });
});

describe('codex folded instance credentials', () => {
  const bothInstances = {
    'openai.main': { instanceOf: 'openai', name: 'OpenAI Main (drewrypope)' },
    'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
  };

  beforeEach(() => {
    setMergedConfig({ provider: bothInstances });
    authState.rows = [
      oauthRow('openai.main', { id: 'cred_main', label: 'OAuth', active: true, access: 'legacy-token', accountId: 'acc_main' }),
      oauthRow('openai.alternate', { id: 'cred_alt', label: 'OAuth', active: true, access: 'alt-token', accountId: 'acc_alt' }),
    ];
    authState.projected = {
      'openai.main': authState.rows[0].value,
      'openai.alternate': authState.rows[1].value,
    };
  });

  it('folds instance rows into the base Codex answer, one per account', async () => {
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(2);

    const [main, alternate] = results;
    expect(main.providerId).toBe('codex');
    expect(main.providerName).toBe('OpenAI Main (drewrypope)');
    expect(main.credentialId).toBe('cred_main');
    expect(main.accountLabel).toBe('drewrypope@gmail.com');
    expect(main.ok).toBe(true);
    expect(main.usage.windows.weekly.usedPercent).toBe(8);

    expect(alternate.providerId).toBe('codex');
    expect(alternate.providerName).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(alternate.credentialId).toBe('cred_alt');
    expect(alternate.accountLabel).toBe('popesdrew@gmail.com');
    expect(alternate.ok).toBe(true);
    expect(alternate.usage.windows.weekly.usedPercent).toBe(12);
  });

  it('lists codex as configured through its instances', async () => {
    const configured = await listConfiguredQuotaProviders({}, authDeps);
    expect(configured).toContain('codex');
    expect(configured).toContain('openai.main');
    expect(configured).toContain('openai.alternate');
  });

  it('leaves a disabled instance out of the fold', async () => {
    setMergedConfig({ disabled_providers: ['openai.alternate'], provider: bothInstances });
    const results = await fetchQuotaForProviderInstances('codex', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].credentialId).toBe('cred_main');
  });

  it('keeps the single fetch on the first usable instance credential', async () => {
    const result = await fetchQuotaForProvider('codex', authDeps);
    expect(result.ok).toBe(true);
    expect(result.accountLabel).toBe('drewrypope@gmail.com');
  });
});

describe('provider catalogue', () => {
  it('lists every provider with its display name and credential aliases', () => {
    const catalogue = listQuotaProviderCatalogue();
    const codex = catalogue.find((entry) => entry.id === 'codex');
    expect(codex?.name).toBe('Codex');
    expect(codex?.aliases).toEqual(expect.arrayContaining(['openai', 'chatgpt']));
    expect(codex?.disabled).toBe(false);
    const copilot = catalogue.find((entry) => entry.id === 'github-copilot');
    expect(copilot?.name).toBe('GitHub Copilot');
    expect(copilot?.aliases).toContain('copilot');
  });

  it('marks providers the merged config turns off as disabled', () => {
    setMergedConfig({ disabled_providers: ['openrouter', 'github-copilot'] });
    const catalogue = listQuotaProviderCatalogue();
    expect(catalogue.find((entry) => entry.id === 'openrouter')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'github-copilot')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'codex')?.disabled).toBe(false);
  });

  it('includes configured provider instances under their own id and name', () => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    const catalogue = listQuotaProviderCatalogue();
    const instance = catalogue.find((entry) => entry.id === 'openai.alternate');
    expect(instance?.name).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(instance?.instanceOf).toBe('codex');
    expect(instance?.disabled).toBe(false);
  });
});

describe('prototype provider ids', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'treats %s as an unsupported provider, like an unknown id',
    async (providerId) => {
      const result = await fetchQuotaForProvider(providerId, authDeps);
      expect(result).toMatchObject({ configured: false, error: 'Unsupported provider' });

      const [instanceResult] = await fetchQuotaForProviderInstances(providerId, authDeps);
      expect(instanceResult).toMatchObject({ configured: false, error: 'Unsupported provider' });
    },
  );
});

describe('opencode-go folded instance credentials (popesdrew labelled row)', () => {
  // The popesdrew account's credential is a Console sign-in stored under its
  // OWN instance integration (opencode-go.popesdrew), not under the shared
  // `opencode` integration the base per-credential walk reads. The base
  // answer must fold the instance row in, labelled, and the instance ask
  // must answer for it instead of "Not configured".
  const consoleInstanceRow = {
    id: 'cred_popesdrew',
    integrationID: 'opencode-go.popesdrew',
    label: 'OpenCode Go (popesdrew)',
    active: true,
    value: {
      type: 'oauth',
      access: 'token-org_POPESDREW1',
      refresh: 'rt',
      expires: Date.now() + 3_600_000,
      server: 'https://opencode.ai/console',
      orgID: 'org_POPESDREW1',
    },
  };

  beforeEach(() => {
    setMergedConfig({
      provider: {
        'opencode-go.popesdrew': { instanceOf: 'opencode-go', name: 'OpenCode Go (popesdrew)' },
      },
    });
    authState.rows = [consoleInstanceRow];
  });

  it('folds the instance console row into the base answer, labelled', async () => {
    const results = await fetchQuotaForProviderInstances('opencode-go', authDeps);
    const popesdrew = results.find((result) => result.credentialId === 'cred_popesdrew');
    expect(popesdrew).toBeDefined();
    expect(popesdrew.providerId).toBe('opencode-go');
    expect(popesdrew.providerName).toBe('OpenCode Go (popesdrew)');
    expect(popesdrew.credentialLabel).toBe('OpenCode Go (popesdrew)');
    expect(popesdrew.ok).toBe(true);
    expect(popesdrew.accountLabel).toBe('org_POPESDREW1');
    expect(popesdrew.usage.windows['5h'].usedPercent).toBe(25);
  });

  it('answers the instance ask for the console row stored under the instance integration', async () => {
    const results = await fetchQuotaForProviderInstances('opencode-go.popesdrew', authDeps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialId).toBe('cred_popesdrew');
  });

  it('lists the instance as configured', async () => {
    const configured = await listConfiguredQuotaProviders({}, authDeps);
    expect(configured).toContain('opencode-go.popesdrew');
  });
});
