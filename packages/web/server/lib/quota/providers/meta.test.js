import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchQuota, isConfigured, readMuseAccountToken, resetMetaQuotaCache } from './meta.js';

afterEach(() => {
  vi.unstubAllGlobals();
  resetMetaQuotaCache();
});

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

// The OpenCode `meta` credential the fleet stores: the subscription's minted
// inference key, which the usage endpoint refuses.
const mintedKeyAuth = async () => ({ meta: { type: 'api', key: 'LLM|test-minted-key' } });
const accountToken = () => 'dca:test-account-token';

// Shape verified live against POST https://api.meta.ai/muse-code/key (2026-10-27).
const USAGE_PAYLOAD = {
  is_subs_active: true,
  require_payment: false,
  subs_tier_name: 'Muse Code High Usage',
  subs_tier_id: 'tier_test_high_usage',
  user_email: 'user@example.com',
  subs_usage: {
    window: { used_percent: 6, window_duration_mins: 300, resets_at: 1793090405 },
    weekly: { used_percent: 10, resets_at: 1793577600 },
    tier: 'tier_test_high_usage',
  },
};

describe('Meta quota provider configuration', () => {
  it('is configured when the OpenCode meta credential carries a key', () => {
    expect(isConfigured({ meta: { type: 'api', key: 'LLM|test' } })).toBe(true);
  });

  it('is configured when the OpenCode meta credential carries an account token', () => {
    expect(isConfigured({ meta: { type: 'oauth', access: 'dca:test' } })).toBe(true);
  });

  it('is not configured without a meta credential', () => {
    expect(isConfigured({})).toBe(false);
  });

  it('answers null for a missing Muse CLI store instead of throwing', () => {
    expect(readMuseAccountToken({ filePath: '/nonexistent/muse-auth.json' })).toBeNull();
  });

  it('reads the account token from a small Muse CLI store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-meta-auth-'));
    const filePath = path.join(dir, 'auth.json');
    const token = 'dca:test-muse-account-token';
    try {
      fs.writeFileSync(filePath, JSON.stringify({ providers: { meta: { access_token: token } } }));

      expect(readMuseAccountToken({ filePath })).toBe(token);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers null for a non-regular Muse CLI store path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-meta-auth-'));
    try {
      expect(readMuseAccountToken({ filePath: dir })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers null for an over-cap Muse CLI store without returning its token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-meta-auth-'));
    const filePath = path.join(dir, 'auth.json');
    const token = 'dca:test-muse-account-token';
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        providers: { meta: { access_token: token } },
        padding: 'x'.repeat(64 * 1024),
      }));

      expect(readMuseAccountToken({ filePath })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('answers null promptly for a FIFO Muse CLI store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-meta-auth-'));
    const filePath = path.join(dir, 'auth.json');
    try {
      execFileSync('mkfifo', [filePath]);
      const output = execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        'import { readMuseAccountToken } from "./server/lib/quota/providers/meta.js"; process.stdout.write(String(readMuseAccountToken({ filePath: process.argv.at(-1) })));',
        filePath,
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });

      expect(output).toBe('null');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Meta quota windows', () => {
  it('maps the rolling window and the weekly window from the plan payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(USAGE_PAYLOAD));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('meta');
    expect(result.planLabel).toBe('Muse Code High Usage');
    expect(result.accountLabel).toBe('user@example.com');

    const rolling = result.usage.windows['5h'];
    expect(rolling.usedPercent).toBe(6);
    expect(rolling.windowSeconds).toBe(18000);
    expect(rolling.resetAt).toBe(1793090405 * 1000);

    const weekly = result.usage.windows.weekly;
    expect(weekly.usedPercent).toBe(10);
    expect(weekly.windowSeconds).toBe(604800);
    expect(weekly.resetAt).toBe(1793577600 * 1000);
  });

  it('clamps out-of-range percentages to [0, 100]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      is_subs_active: true,
      subs_usage: {
        window: { used_percent: 150, window_duration_mins: 300 },
        weekly: { used_percent: -20 },
      },
    }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(100);
    expect(result.usage.windows['5h'].remainingPercent).toBe(0);
    expect(result.usage.windows.weekly.usedPercent).toBe(0);
    expect(result.usage.windows.weekly.remainingPercent).toBe(100);
  });

  it('keeps a missing used_percent unknown instead of inventing a value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      is_subs_active: true,
      subs_usage: {
        window: { window_duration_mins: 300 },
        weekly: {},
      },
    }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBeNull();
    expect(result.usage.windows.weekly.usedPercent).toBeNull();
  });

  it('labels an unnamed rolling window without guessing a duration', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      is_subs_active: true,
      subs_usage: { window: { used_percent: 3 } },
    }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.rolling.usedPercent).toBe(3);
    expect(result.usage.windows.rolling.windowSeconds).toBeNull();
    expect(result.usage.windows.weekly).toBeUndefined();
  });

  it('reads the plan usage with the OpenCode account token when it holds one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(USAGE_PAYLOAD));
    const readAccountToken = vi.fn(() => null);

    const result = await fetchQuota({
      readAuth: async () => ({ meta: { access: 'dca:opencode-account-token' } }),
      readAccountToken,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer dca:opencode-account-token');
    expect(readAccountToken).not.toHaveBeenCalled();
  });

  it('reports an empty reading when an active payload carries no subs_usage (post-roll shape)', async () => {
    // Shape captured live on 2026-10-28 in the post-roll state: 200,
    // is_subs_active true, require_payment false, tier named, subs_usage
    // absent entirely.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      is_subs_active: true,
      require_payment: false,
      subs_tier_name: 'Muse Code High Usage',
      user_email: 'user@example.com',
    }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.planLabel).toBe('Muse Code High Usage');
    expect(result.usage.windows.rolling.usedPercent).toBeNull();
    expect(result.usage.windows.rolling.windowSeconds).toBeNull();
    expect(result.usage.windows.weekly.usedPercent).toBeNull();
    expect(result.usage.windows.weekly.windowSeconds).toBe(604800);
  });

  it('reports an empty reading when subs_usage is empty or its windows are null', async () => {
    for (const subsUsage of [{}, { window: null, weekly: null }]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
        is_subs_active: true,
        subs_usage: subsUsage,
      }));

      const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

      expect(result.ok).toBe(true);
      expect(result.usage.windows.rolling.usedPercent).toBeNull();
      expect(result.usage.windows.weekly.usedPercent).toBeNull();
    }
  });

  it('reports no quota data when the payload carries no usage windows and no active flag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Usage unknown — Meta plan-usage read returned no quota data');
    expect(result.failureClass).toBe('no-data');
    expect(result.lastSuccessAt).toBeNull();
  });

  it('carries the last success timestamp on a later failure, and the failure class', async () => {
    const okFetch = vi.fn().mockResolvedValue(jsonResponse(USAGE_PAYLOAD));
    const okResult = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl: okFetch });
    expect(okResult.ok).toBe(true);
    expect(okResult.lastSuccessAt).toBe(okResult.fetchedAt);

    const failFetch = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));
    const failResult = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl: failFetch });
    expect(failResult.ok).toBe(false);
    expect(failResult.failureClass).toBe('http-error');
    expect(failResult.lastSuccessAt).toBe(okResult.fetchedAt);
  });
});

describe('Meta credential sourcing', () => {
  it('falls back to the Muse CLI account token when OpenCode holds the minted key', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ title: 'Authentication Error' }, { ok: false, status: 401 }))
      .mockResolvedValueOnce(jsonResponse(USAGE_PAYLOAD));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer LLM|test-minted-key');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer dca:test-account-token');
  });

  it('names the account login when no credential can read plan usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ title: 'Authentication Error' }, { ok: false, status: 401 }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: () => null, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('account login');
    expect(result.quotaExhausted).toBeUndefined();
  });

  it('reports not configured without any meta credential', async () => {
    const fetchImpl = vi.fn();

    const result = await fetchQuota({
      readAuth: async () => ({}),
      readAccountToken: () => null,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Meta failure classes', () => {
  it('reports a 402 wall as a distinct quota-exhausted state, not a read failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { quota: { limitKind: 'weekly', resetsAtMs: 1793577600000, tier: 'Muse Code High Usage' } },
      { ok: false, status: 402 },
    ));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.quotaExhausted).toBe(true);
    expect(result.quotaResetAt).toBe(1793577600000);
    expect(result.quotaLimitKind).toBe('weekly');
    expect(result.planLabel).toBe('Muse Code High Usage');
  });

  it('reports a 429 as quota-exhausted and keeps the body reset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Subscription quota exhausted', quota: { resetsAtMs: 1793577600000 } },
      { ok: false, status: 429 },
    ));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.quotaExhausted).toBe(true);
    expect(result.quotaResetAt).toBe(1793577600000);
    expect(result.error).toContain('Subscription quota exhausted');
  });

  it('treats a require_payment demand as the plan wall', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      is_subs_active: true,
      require_payment: true,
      action_url: 'https://example.test/pay',
    }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.quotaExhausted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('reports an inactive subscription as a configured failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ is_subs_active: false }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.quotaExhausted).toBeUndefined();
    expect(result.error).toBe('Meta subscription is inactive');
  });

  it('maps a plain HTTP error to an API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API error: 500');
  });

  it('reports a malformed body as an invalid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });

  it('reports a body-read transport failure as transport, not malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new TypeError('terminated'); },
    });

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('transport');
    expect(result.error).toBe('terminated');
  });

  it('reports a body-read timeout as a timeout, not malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
    });

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('transport');
    expect(result.error).toBe('Request timed out');
  });

  it('reports a normalized timeout', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const result = await fetchQuota({ readAuth: mintedKeyAuth, readAccountToken: accountToken, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
  });
});
