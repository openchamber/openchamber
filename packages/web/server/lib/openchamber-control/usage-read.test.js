import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createUsageReadAction } from './usage-read.js';

const PAGE = [
  { providerId: 'claude', providerName: 'Claude' },
  { providerId: 'codex', providerName: 'Codex' },
  { providerId: 'github-copilot', providerName: 'GitHub Copilot' },
  { providerId: 'ext-acme', providerName: 'Acme' },
];

const sample = (providerId, extra = {}) => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  usage: {
    windows: { '5h': { usedPercent: 42, remainingPercent: 58, windowSeconds: 18_000, resetAfterSeconds: 600, resetAt: 1_800_000_000_000, resetAtFormatted: '10:00', resetAfterFormatted: '10:00' } },
  },
  fetchedAt: 1_700_000_000_000,
  ...extra,
});

const setup = ({
  settings = { agentUsageToolEnabled: true },
  configured = () => Promise.resolve(['claude', 'codex']),
  answer = (providerId) => Promise.resolve(sample(providerId)),
  ...options
} = {}) => {
  const reads = [];
  let listReads = 0;
  const quota = {
    listUsagePageProviders: () => PAGE,
    listConfiguredQuotaProviders: () => {
      listReads += 1;
      return configured();
    },
    fetchQuotaForProvider: (providerId) => {
      reads.push(providerId);
      return answer(providerId);
    },
  };
  const read = createUsageReadAction({
    readSettings: async () => settings,
    loadQuota: async () => quota,
    ...options,
  });
  return { read, reads, listReads: () => listReads };
};

const never = () => new Promise(() => {});

describe('usage.read', () => {
  it('refuses while the tool is off, before asking any provider', async () => {
    for (const settings of [{}, { agentUsageToolEnabled: false }, null]) {
      const { read, reads, listReads } = setup({ settings });
      await expect(read({})).rejects.toMatchObject({ statusCode: 403 });
      expect(reads).toEqual([]);
      expect(listReads()).toBe(0);
    }
  });

  it('reads every configured provider and names the rest as not configured', async () => {
    const codex = sample('codex', {
      planLabel: 'Pro',
      accountLabel: 'me@example.com',
      usage: { windows: {}, models: { 'gpt-5': { windows: {} } }, consoleBudgets: { workspace: 'w', budgets: [] } },
    });
    const { read, reads } = setup({ answer: (id) => Promise.resolve(id === 'codex' ? codex : sample(id)) });

    const result = await read({});

    expect(reads).toEqual(['claude', 'codex']);
    expect(result.providers.map((entry) => entry.providerId)).toEqual(['claude', 'codex']);
    // What the Usage page sees, without the account it is signed in with.
    const { accountLabel: _accountLabel, ...withoutAccount } = codex;
    expect(result.providers[1]).toEqual(withoutAccount);
    expect(result.providers[1].accountLabel).toBeUndefined();
    expect(result.providers[1].planLabel).toBe('Pro');
    expect(result.notConfigured).toEqual(['github-copilot', 'ext-acme']);
    expect(result.listError).toBeUndefined();
  });

  it('never reads a configured provider the Usage page does not read', async () => {
    const { read, reads } = setup({ configured: () => Promise.resolve(['claude', 'github-copilot', 'github-copilot-addon']) });

    const result = await read({});

    expect(reads).toEqual(['claude', 'github-copilot']);
    expect(result.notConfigured).not.toContain('github-copilot-addon');
    await expect(read({ providerId: 'github-copilot-addon' })).rejects.toMatchObject({ statusCode: 400 });
    expect(reads).toEqual(['claude', 'github-copilot']);
  });

  it('answers an empty configured list as no providers, with every page provider not configured', async () => {
    const { read, reads } = setup({ configured: () => Promise.resolve([]) });

    expect(await read({})).toEqual({ providers: [], notConfigured: ['claude', 'codex', 'github-copilot', 'ext-acme'] });
    expect(reads).toEqual([]);
  });

  it('keeps the other providers when one throws or does not answer in time', async () => {
    const { read } = setup({
      providerTimeoutMs: 20,
      answer: (id) => {
        if (id === 'claude') return Promise.reject(new Error('Malformed extension answer'));
        if (id === 'codex') return never();
        return Promise.resolve(sample(id));
      },
      configured: () => Promise.resolve(['claude', 'codex', 'github-copilot']),
    });

    const { providers } = await read({});

    expect(providers[0]).toMatchObject({ providerId: 'claude', providerName: 'Claude', ok: false, configured: true, usage: null, error: 'Malformed extension answer' });
    expect(providers[1]).toMatchObject({ providerId: 'codex', providerName: 'Codex', ok: false, configured: true, usage: null, error: expect.stringContaining('No answer within') });
    expect(providers[1].fetchedAt).toEqual(expect.any(Number));
    expect(providers[2]).toEqual(sample('github-copilot'));
  });

  it('asks every page provider when the configured list fails, never answering "none configured"', async () => {
    const { read, reads } = setup({ configured: () => Promise.reject(new Error('OpenCode is not running')) });

    const result = await read({});

    expect(reads).toEqual(['claude', 'codex', 'github-copilot', 'ext-acme']);
    expect(result.providers).toHaveLength(4);
    expect(result.notConfigured).toBeUndefined();
    expect(result.listError).toContain('OpenCode is not running');
  });

  it('asks every page provider when the configured list does not answer in time', async () => {
    const { read, reads } = setup({ configured: never, listTimeoutMs: 20 });

    const result = await read({});

    expect(reads).toEqual(['claude', 'codex', 'github-copilot', 'ext-acme']);
    expect(result.listError).toContain('did not say which providers are configured');
  });

  it('reads only the named provider, without the list read', async () => {
    const { read, reads, listReads } = setup();

    expect(await read({ providerId: 'codex' })).toEqual({ providers: [sample('codex')] });
    expect(reads).toEqual(['codex']);
    expect(listReads()).toBe(0);
  });

  it('refuses an unknown provider id with the ids it can read', async () => {
    const { read, reads } = setup();

    const failure = read({ providerId: 'anthropic' });

    await expect(failure).rejects.toMatchObject({ statusCode: 400 });
    await expect(failure).rejects.toThrow('claude, codex, github-copilot, ext-acme');
    expect(reads).toEqual([]);
  });

  it('stops waiting when the turn is cancelled', async () => {
    const controller = new AbortController();
    const { read } = setup({ answer: never });

    const pending = read({}, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
  });
});

describe('the providers the Usage page reads', () => {
  it('are the built-ins the page lists, then the extensions', async () => {
    const { listUsagePageProviders } = await import('../quota/index.js');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const pageSource = fs.readFileSync(path.join(root, 'packages/ui/src/lib/quota/providers/index.ts'), 'utf8');
    const pageIds = [...pageSource.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);

    expect(pageIds.length).toBeGreaterThan(10);
    expect(listUsagePageProviders().map(({ providerId }) => providerId).sort()).toEqual([...pageIds].sort());
  });
});
