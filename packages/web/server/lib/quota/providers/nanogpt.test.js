import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '../../opencode/auth.js';
import * as nanogpt from './nanogpt.js';

/**
 * Sanitized NanoGPT API response fixtures (fake keys, realistic shapes).
 * Mirrors the canonical NanoGPT API contracts ported from
 * mystatus/plugin/mystatus.ts (`queryNanoGptCredential`):
 *
 *   POST https://nano-gpt.com/api/check-balance
 *     -> { usd_balance?: string, nano_balance?: string }
 *   GET  https://nano-gpt.com/api/subscription/v1/usage
 *     -> NanoGptSubscription {
 *          active?: boolean,
 *          provider?: string,
 *          cancelAtPeriodEnd?: boolean,
 *          limits?: { weeklyInputTokens?, dailyInputTokens?, dailyImages? },
 *          period?: { currentPeriodEnd?: string },
 *          weeklyInputTokens?: { used?, remaining?, percentUsed?, resetAt? },
 *          dailyInputTokens?:  { used?, remaining?, percentUsed?, resetAt? },
 *          dailyImages?:       { used?, remaining?, percentUsed?, resetAt? },
 *        }
 *
 * Canonical headers (per credential):
 *   x-api-key: <credential.key>
 *   Content-Type: application/json
 *   User-Agent: OpenCode-AllStatus/1.0
 *
 * Auth resolution (canonical `resolveNanoGptCredentials`):
 *   - Multi-auth keys file `nanogpt-keys.json` under opencode data dirs.
 *   - Native `auth.json` entry under `nano-gpt` (aliases: nanogpt, nano_gpt).
 *   - Dedup by key; multi-auth takes precedence over native.
 */

const BALANCE_FIXTURE = {
  usd_balance: '12.50',
  nano_balance: '1.2345',
};

const SUBSCRIPTION_FIXTURE = {
  active: true,
  provider: 'stripe',
  cancelAtPeriodEnd: false,
  limits: {
    weeklyInputTokens: 1_000_000,
    dailyInputTokens: 200_000,
    dailyImages: 100,
  },
  period: { currentPeriodEnd: '2026-07-01T00:00:00.000Z' },
  weeklyInputTokens: { used: 250_000, remaining: 750_000, resetAt: 1_750_000_000_000 },
  dailyInputTokens: { used: 50_000, remaining: 150_000, resetAt: 1_750_000_000_000 },
  dailyImages: { used: 25, remaining: 75, resetAt: 1_750_000_000_000 },
};

describe('nanogpt quota provider', () => {
  let readAuthFileSpy;
  let candidateDataDirsSpy;
  let fetchSpy;

  beforeEach(() => {
    readAuthFileSpy = vi.spyOn(authModule, 'readAuthFile');
    candidateDataDirsSpy = vi.spyOn(authModule, 'candidateDataDirs');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    readAuthFileSpy.mockReturnValue({});
    candidateDataDirsSpy.mockReturnValue([]);
    expect(nanogpt.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when native auth.json has nano-gpt key', () => {
    readAuthFileSpy.mockReturnValue({ 'nano-gpt': { type: 'api', key: 'fake-native-key' } });
    candidateDataDirsSpy.mockReturnValue([]);
    expect(nanogpt.isConfigured()).toBe(true);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    readAuthFileSpy.mockReturnValue({});
    candidateDataDirsSpy.mockReturnValue([]);
    const result = await nanogpt.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
  });

  it('transforms single native credential: balance + subscription windows', async () => {
    readAuthFileSpy.mockReturnValue({ 'nano-gpt': { type: 'api', key: 'fake-native-key' } });
    candidateDataDirsSpy.mockReturnValue([]);

    // balance (POST) + subscription (GET) in parallel.
    fetchSpy.mockImplementation(async (url) => {
      if (url === 'https://nano-gpt.com/api/check-balance') {
        return { ok: true, json: async () => BALANCE_FIXTURE };
      }
      if (url === 'https://nano-gpt.com/api/subscription/v1/usage') {
        return { ok: true, json: async () => SUBSCRIPTION_FIXTURE };
      }
      return { ok: false, status: 404 };
    });

    const result = await nanogpt.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeTruthy();

    // Two endpoints called: balance (POST) + subscription (GET).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://nano-gpt.com/api/check-balance');
    expect(urls).toContain('https://nano-gpt.com/api/subscription/v1/usage');

    // Canonical headers: x-api-key (NOT Authorization Bearer).
    for (const [, opts] of fetchSpy.mock.calls) {
      expect(opts.headers['x-api-key']).toBe('fake-native-key');
      expect(opts.headers.Authorization).toBeUndefined();
      expect(opts.headers['User-Agent']).toBe('OpenCode-AllStatus/1.0');
    }

    // Header carries balance + plan lines.
    expect(Array.isArray(result.usage.header)).toBe(true);
    expect(result.usage.header.some((l) => l.includes('$12.50'))).toBe(true);
    expect(result.usage.header.some((l) => l.includes('1.2345'))).toBe(true);
    expect(result.usage.header.some((l) => l.includes('Subscription'))).toBe(true);

    // Three subscription windows emitted.
    const windows = result.usage.windows;
    const allWindows = Object.values(windows);
    expect(allWindows.length).toBe(3);

    // Weekly input tokens: used=250k, total=1M -> 25% used.
    const weekly = allWindows.find((w) => w.valueLabel === 'Weekly input tokens');
    expect(weekly).toBeDefined();
    expect(weekly.usedPercent).toBe(25);
    expect(weekly.remainingPercent).toBe(75);
    expect(weekly.detail.some((l) => l.includes('250K') && l.includes('1M'))).toBe(true);

    // Daily input tokens: used=50k, total=200k -> 25% used.
    const dailyTokens = allWindows.find((w) => w.valueLabel === 'Daily input tokens');
    expect(dailyTokens).toBeDefined();
    expect(dailyTokens.usedPercent).toBe(25);

    // Daily images: used=25, total=100 -> 25% used.
    const dailyImages = allWindows.find((w) => w.valueLabel === 'Daily images');
    expect(dailyImages).toBeDefined();
    expect(dailyImages.usedPercent).toBe(25);

    // Footer carries renewal line.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Renews'))).toBe(true);

    // Single account -> no accounts[] (multi only).
    expect(result.usage.accounts).toBeUndefined();
  });

  it('emits accounts[] for 2 credentials (multi-auth + native)', async () => {
    // Multi-auth keys file present in a data dir.
    candidateDataDirsSpy.mockReturnValue(['/fake/opencode/data']);
    // Stub fs.existsSync/readFileSync for nanogpt-keys.json.
    const fs = await import('fs');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/fake/opencode/data/nanogpt-keys.json');
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === '/fake/opencode/data/nanogpt-keys.json') {
        return JSON.stringify({
          version: 1,
          keys: [
            { id: 'k1', label: 'Pool A', key: 'fake-multi-key-a', enabled: true },
            { id: 'k2', label: 'Pool B', key: 'fake-multi-key-b', enabled: true },
          ],
        });
      }
      return '';
    });

    // Native auth also present (deduped; different key).
    readAuthFileSpy.mockReturnValue({ 'nano-gpt': { type: 'api', key: 'fake-native-key' } });

    // 3 credentials total (2 multi + 1 native). Each calls balance + sub.
    fetchSpy.mockImplementation(async (url, opts) => {
      const key = opts.headers['x-api-key'];
      // Per-account balance fixture.
      const bal = { usd_balance: key === 'fake-multi-key-a' ? '10.00' : '20.00', nano_balance: '0' };
      // Per-account subscription fixture.
      const sub = {
        ...SUBSCRIPTION_FIXTURE,
        weeklyInputTokens: {
          used: key === 'fake-multi-key-a' ? 100_000 : 500_000,
          remaining: 900_000,
          resetAt: 1_750_000_000_000,
        },
      };
      if (url === 'https://nano-gpt.com/api/check-balance') {
        return { ok: true, json: async () => bal };
      }
      if (url === 'https://nano-gpt.com/api/subscription/v1/usage') {
        return { ok: true, json: async () => sub };
      }
      return { ok: false, status: 404 };
    });

    const result = await nanogpt.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);

    // 3 credentials * 2 endpoints = 6 fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // Multi-account -> accounts[] present with all 3 entries.
    expect(Array.isArray(result.usage.accounts)).toBe(true);
    expect(result.usage.accounts).toHaveLength(3);

    const [acct0, acct1, acct2] = result.usage.accounts;
    // Multi-auth credentials first (in file order), then native.
    expect(acct0.subtitle).toBe('Pool A');
    expect(acct0.windows).toBeTruthy();
    expect(acct1.subtitle).toBe('Pool B');
    expect(acct2.subtitle).toBe('Native auth');

    // Top-level usage carries the FIRST account's data.
    const topWindows = Object.values(result.usage.windows);
    expect(topWindows.length).toBe(3);
    const topWeekly = topWindows.find((w) => w.valueLabel === 'Weekly input tokens');
    // Pool A: used=100k, total=1M -> 10% used.
    expect(topWeekly.usedPercent).toBe(10);

    // Each account has its own windows with distinct values.
    const acct1Weekly = Object.values(acct1.windows).find((w) => w.valueLabel === 'Weekly input tokens');
    // Pool B: used=500k, total=1M -> 50% used.
    expect(acct1Weekly.usedPercent).toBe(50);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('falls back to pay-as-you-go when subscription endpoint fails', async () => {
    readAuthFileSpy.mockReturnValue({ 'nano-gpt': { type: 'api', key: 'fake-key' } });
    candidateDataDirsSpy.mockReturnValue([]);

    fetchSpy.mockImplementation(async (url) => {
      if (url === 'https://nano-gpt.com/api/check-balance') {
        return { ok: true, json: async () => ({ usd_balance: '5.00' }) };
      }
      // Subscription endpoint non-ok -> treated as no subscription.
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const result = await nanogpt.fetchQuota();
    expect(result.ok).toBe(true);
    // No subscription windows.
    expect(Object.keys(result.usage.windows)).toHaveLength(0);
    // Header shows pay-as-you-go plan.
    expect(result.usage.header.some((l) => l.includes('Pay-as-you-go'))).toBe(true);
    // No footer (no renewal line).
    expect(result.usage.footer).toBeUndefined();
  });

  it('returns ok:false when balance endpoint returns non-ok', async () => {
    readAuthFileSpy.mockReturnValue({ 'nano-gpt': { type: 'api', key: 'fake-key' } });
    candidateDataDirsSpy.mockReturnValue([]);

    fetchSpy.mockImplementation(async (url) => {
      if (url === 'https://nano-gpt.com/api/check-balance') {
        return { ok: false, status: 401, text: async () => 'unauthorized' };
      }
      return { ok: true, json: async () => SUBSCRIPTION_FIXTURE };
    });

    const result = await nanogpt.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/401/);
  });
});