import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as longcat from './longcat.js';

// Sanitized canonical response shapes (fake token values, realistic numeric
// fields). Mirrors longcat.chat API contracts ported from
// mystatus/plugin/mystatus.ts:
//   GET /api/lc-platform/v1/tokenUsage?day=today  -> LongCatEnvelope<LongCatTokenUsageData>
//   GET /api/v1/user-current                       -> LongCatEnvelope<LongCatUserCurrent>
//   GET /api/lc-platform/v1/query-active-apiKeys   -> LongCatEnvelope<LongCatApiKeysData>
//
// LongCatEnvelope<T> = { code: number, message: string, data: T | null }
// LongCatTokenUsageData = { extData?: Record<string, LongCatModelUsage>, usage?: LongCatModelUsage }
// LongCatModelUsage = {
//   totalToken?, usedToken?, availableToken?, aliasName?,
//   freeRefreshToken?, freeUsedToken?, freeAvailableToken?,
//   fuelPackageList?: LongCatFuelPackage[] | null,
// }
// LongCatFuelPackage = { quota?, remainQuota?, daysUntilExpire?, expireTime?, modelName? }
// LongCatUserCurrent = { email?, name?, userId? }
// LongCatApiKeysData = { extData?: { activeKeyCount?, createKeyCount? } }
//
// Canonical host: https://longcat.chat
// Canonical headers (longcatPlatformHeaders):
//   Cookie: passport_token_key=<token>; long_cat_region_key=<region>
//   m-appkey: fe_com.sankuai.friday.longcat.platform
//   content-type: application/json
//   x-client-language: en
//   x-requested-with: XMLHttpRequest
//   Accept: */*
//   Referer: https://longcat.chat/platform/usage
//   User-Agent: OpenCode-AllStatus/1.0

const PASSPORT_TOKEN = 'fake-passport-token';
const COOKIE = `passport_token_key=${PASSPORT_TOKEN}; long_cat_region_key=2; other=fake`;

// Two models in extData. Sorted by key (localeCompare) per canonical
// longcatModelEntries.
//
// Model "glm-4.6":
//   freeRefreshToken=1000, freeAvailableToken=750 -> free remaining 75%, used 25%
//   totalToken=5000, availableToken=4000          -> total remaining 80%, used 20%
//   fuelPackageList: 1 active package, 500 remain, 7d to expiry
// Model "glm-4.6-air":
//   freeRefreshToken=2000, freeAvailableToken=500 -> free remaining 25%, used 75%
//   totalToken=0 (skipped: total branch requires total > 0)
//   no fuel packages
const TOKEN_USAGE_RESPONSE = {
  code: 0,
  message: 'ok',
  data: {
    extData: {
      'glm-4.6-air': {
        totalToken: 0,
        usedToken: 0,
        availableToken: 0,
        aliasName: 'GLM 4.6 Air',
        freeRefreshToken: 2000,
        freeUsedToken: 1500,
        freeAvailableToken: 500,
        fuelPackageList: null,
      },
      'glm-4.6': {
        totalToken: 5000,
        usedToken: 1000,
        availableToken: 4000,
        aliasName: 'GLM 4.6',
        freeRefreshToken: 1000,
        freeUsedToken: 250,
        freeAvailableToken: 750,
        fuelPackageList: [
          {
            quota: 1000,
            remainQuota: 500,
            daysUntilExpire: 7,
            expireTime: null,
            modelName: 'glm-4.6',
          },
        ],
      },
      // Skipped keys per canonical LONGCAT_EXT_SKIP_KEYS.
      applyButtonGray: { totalToken: 1 },
      newUser: { freeRefreshToken: 1 },
    },
  },
};

const USER_CURRENT_RESPONSE = {
  code: 0,
  message: 'ok',
  data: {
    email: 'jane@example.com',
    name: 'Jane Doe',
    userId: 12345,
  },
};

const API_KEYS_RESPONSE = {
  code: 0,
  message: 'ok',
  data: {
    extData: {
      activeKeyCount: 3,
      createKeyCount: 5,
    },
  },
};

describe('longcat quota provider', () => {
  let getCredentialSpy;
  let fetchSpy;

  beforeEach(() => {
    getCredentialSpy = vi.spyOn(store, 'getCredential');
    fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    getCredentialSpy.mockReturnValue(undefined);
    expect(longcat.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when passportToken present', () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    expect(longcat.isConfigured()).toBe(true);
  });

  it('isConfigured returns true when cookie contains passport_token_key=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    expect(longcat.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when cookie lacks passport_token_key=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    expect(longcat.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await longcat.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when cookie lacks passport_token_key=', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    const result = await longcat.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical tokenUsage + user-current + query-active-apiKeys into correct windows/footer', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    // tokenUsage (GET), user-current (GET), query-active-apiKeys (GET) in call order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => TOKEN_USAGE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });

    const result = await longcat.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Three canonical endpoints called in order on https://longcat.chat.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const calls = fetchSpy.mock.calls;
    expect(calls[0][0]).toBe(
      'https://longcat.chat/api/lc-platform/v1/tokenUsage?day=today',
    );
    expect(calls[1][0]).toBe('https://longcat.chat/api/v1/user-current');
    expect(calls[2][0]).toBe(
      'https://longcat.chat/api/lc-platform/v1/query-active-apiKeys',
    );
    // All GETs.
    for (const [, opts] of calls) {
      expect(opts.method).toBeUndefined();
    }

    // Canonical headers on every call. passportToken credential -> cookie
    // built as passport_token_key=<token>; long_cat_region_key=<region>.
    for (const [, opts] of calls) {
      expect(opts.headers.Cookie).toBe(
        `passport_token_key=${PASSPORT_TOKEN}; long_cat_region_key=2`,
      );
      expect(opts.headers['m-appkey']).toBe('fe_com.sankuai.friday.longcat.platform');
      expect(opts.headers['content-type']).toBe('application/json');
      expect(opts.headers['x-client-language']).toBe('en');
      expect(opts.headers['x-requested-with']).toBe('XMLHttpRequest');
      expect(opts.headers.Accept).toBe('*/*');
      expect(opts.headers.Referer).toBe('https://longcat.chat/platform/usage');
      expect(opts.headers['User-Agent']).toBe('OpenCode-AllStatus/1.0');
    }

    const windows = result.usage.windows;
    // Multi-model -> 4 windows: glm-4.6 free, glm-4.6 total, glm-4.6-air free.
    // (glm-4.6-air total skipped because totalToken=0.)
    const keys = Object.keys(windows);
    expect(keys.length).toBe(3);

    // Models are processed in localeCompare-sorted order: glm-4.6 first, then glm-4.6-air.
    // Window keys are stable indices; verify by valueLabel/trendKey content.
    const allWindows = Object.values(windows);

    // glm-4.6 Free quota: freeAvailable=750, freeRefresh=1000 -> remaining 75%, used 25%.
    const glm46Free = allWindows.find(
      (w) => w.trendKey === 'GLM 4.6 · Free',
    );
    expect(glm46Free).toBeDefined();
    expect(glm46Free.usedPercent).toBe(25);
    expect(glm46Free.remainingPercent).toBe(75);
    expect(glm46Free.sectionHeader).toBe('GLM 4.6');
    expect(glm46Free.valueLabel).toBe('GLM 4.6 · Free quota');
    expect(Array.isArray(glm46Free.detail)).toBe(true);
    expect(glm46Free.detail.some((l) => l.includes('250') && l.includes('1,000'))).toBe(true);

    // glm-4.6 Total tokens: available=4000, total=5000 -> remaining 80%, used 20%.
    const glm46Total = allWindows.find(
      (w) => w.trendKey === 'GLM 4.6 · Total',
    );
    expect(glm46Total).toBeDefined();
    expect(glm46Total.usedPercent).toBe(20);
    expect(glm46Total.remainingPercent).toBe(80);
    expect(glm46Total.sectionHeader).toBe('GLM 4.6');
    expect(glm46Total.valueLabel).toBe('GLM 4.6 · Total tokens');
    expect(glm46Total.detail.some((l) => l.includes('1,000') && l.includes('5,000'))).toBe(true);

    // glm-4.6-air Free quota: freeAvailable=500, freeRefresh=2000 -> remaining 25%, used 75%.
    const airFree = allWindows.find(
      (w) => w.trendKey === 'GLM 4.6 Air · Free',
    );
    expect(airFree).toBeDefined();
    expect(airFree.usedPercent).toBe(75);
    expect(airFree.remainingPercent).toBe(25);
    expect(airFree.sectionHeader).toBe('GLM 4.6 Air');
    expect(airFree.valueLabel).toBe('GLM 4.6 Air · Free quota');

    // Footer: account email, plan line, active API keys, fuel package summary.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('jane@example.com'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('LongCat API'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Active API keys: 3'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Fuel packages:  1 active'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('500') && l.includes('tokens remaining'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Nearest expiry: 7d'))).toBe(true);
  });

  it('uses provided cookie verbatim and resolves region from long_cat_region_key', async () => {
    const customCookie = 'passport_token_key=other-token; long_cat_region_key=3; extra=1';
    getCredentialSpy.mockReturnValue({ credential: { cookie: customCookie } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => TOKEN_USAGE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });

    const result = await longcat.fetchQuota();
    expect(result.ok).toBe(true);

    // Cookie credential -> cookie sent verbatim (canonical does not rebuild it).
    for (const [, opts] of fetchSpy.mock.calls) {
      expect(opts.headers.Cookie).toBe(customCookie);
    }
  });

  it('defaults region to "2" when passportToken has no region', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => TOKEN_USAGE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });

    await longcat.fetchQuota();
    for (const [, opts] of fetchSpy.mock.calls) {
      expect(opts.headers.Cookie).toContain('long_cat_region_key=2');
    }
  });

  it('returns ok:false (no stale fallback) when tokenUsage returns 401', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await longcat.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('returns ok:false when canonical envelope code is 401 (not logged in)', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 401, message: 'not logged in', data: null }),
    });

    const result = await longcat.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => TOKEN_USAGE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });
    const first = await longcat.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: tokenUsage throws (network/retry exhausted).
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await longcat.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('handles no usage data gracefully (empty extData)', async () => {
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, message: 'ok', data: { extData: {} } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });

    const result = await longcat.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
    // Footer still present: account + plan + active keys lines.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('jane@example.com'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('LongCat API'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Active API keys: 3'))).toBe(true);
  });

  it('handles single-model display (no sectionHeader, plain labels)', async () => {
    const singleModelResponse = {
      code: 0,
      message: 'ok',
      data: {
        extData: {
          'glm-4.6': {
            totalToken: 5000,
            usedToken: 1000,
            availableToken: 4000,
            aliasName: 'GLM 4.6',
            freeRefreshToken: 1000,
            freeUsedToken: 250,
            freeAvailableToken: 750,
            fuelPackageList: null,
          },
        },
      },
    };
    getCredentialSpy.mockReturnValue({ credential: { passportToken: PASSPORT_TOKEN } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => singleModelResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => USER_CURRENT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => API_KEYS_RESPONSE });

    const result = await longcat.fetchQuota();
    expect(result.ok).toBe(true);
    const allWindows = Object.values(result.usage.windows);
    expect(allWindows.length).toBe(2);

    // Single model -> no sectionHeader, plain labels.
    const free = allWindows.find((w) => w.valueLabel === 'Free quota');
    expect(free).toBeDefined();
    expect(free.sectionHeader).toBeUndefined();
    expect(free.trendKey).toBe('GLM 4.6 · Free');

    const total = allWindows.find((w) => w.valueLabel === 'Total tokens');
    expect(total).toBeDefined();
    expect(total.sectionHeader).toBeUndefined();
    expect(total.trendKey).toBe('GLM 4.6 · Total');
  });
});