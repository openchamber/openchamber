import { describe, expect, it, vi } from 'vitest';

import { fetchQuota, isConfigured } from './kimi.js';

const readAuth = () => ({ 'kimi-for-coding': { key: 'test-token' } });

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

describe('Kimi for Coding quota provider', () => {
  it('computes weekly usedPercent from the used field (pre-migration payload, no remaining field)', async () => {
    // Captured from GET https://api.kimi.com/coding/v1/usages before Kimi
    // migrated plans to the ratio-based `usages` map. Plans that have not
    // migrated still answer this way: the weekly `usage` block only ever
    // includes `used`, never `remaining`.
    const fetchImpl = async () => (
      mockResponse({
        usage: { limit: '100', used: '100', resetTime: '2026-08-04T06:21:48.514003Z' },
        limits: [{
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', remaining: '100', resetTime: '2026-08-03T07:21:48.514003Z' },
        }],
      })
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(100);
    expect(result.usage.windows['Rate Limit (300m)'].usedPercent).toBe(0);
  });

  it('falls back to computing usedPercent from remaining when used is absent', async () => {
    const fetchImpl = async () => (
      mockResponse({
        usage: { limit: '2048', remaining: '512', resetTime: '2026-08-04T06:21:48.514003Z' },
        limits: [],
      })
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.usage.windows.weekly.usedPercent).toBe(75);
  });

  it('prefers used over remaining when both fields are present', async () => {
    const fetchImpl = async () => (
      mockResponse({
        usage: { limit: '100', used: '30', remaining: '999', resetTime: null },
        limits: [],
      })
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.usage.windows.weekly.usedPercent).toBe(30);
  });

  it('reports null usedPercent when neither used nor remaining is present', async () => {
    const fetchImpl = async () => (
      mockResponse({
        usage: { limit: '100', resetTime: null },
        limits: [],
      })
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.usage.windows.weekly.usedPercent).toBeNull();
  });

  it('reports not configured when no credentials are stored', async () => {
    const result = await fetchQuota({ readAuth: () => ({}), fetchImpl: async () => { throw new Error('Unexpected fetch'); } });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('skips a blank key and uses the token next to it', async () => {
    const auth = { 'kimi-code-plan-cn': { key: '  ', token: 'cn-token' } };
    let authorization;
    const fetchImpl = async (_url, init) => {
      authorization = init.headers.Authorization;
      return mockResponse({ usage: null, limits: [] });
    };

    await fetchQuota({ readAuth: () => auth, fetchImpl });

    expect(isConfigured(auth)).toBe(true);
    expect(authorization).toBe('Bearer cn-token');
  });

  it('surfaces API errors with status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API error: 401');
  });

  it.each([401, 403])('falls back to the next stored credential after HTTP %s', async (status) => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push({ url, authorization: init.headers.Authorization });
      if (init.headers.Authorization === 'Bearer stale-key') return new Response('{}', { status });
      return mockResponse({ usage: { limit: '100', used: '25', resetTime: null }, limits: [] });
    };

    const result = await fetchQuota({
      readAuth: () => ({
        'kimi-for-coding': { key: 'stale-key' },
        'kimi-code-plan-global': { key: 'live-key' },
      }),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(25);
    expect(urls.map((call) => call.authorization)).toEqual([
      'Bearer stale-key',
      'Bearer stale-key',
      'Bearer live-key',
    ]);
    expect(urls[2].url).toBe('https://api.kimi.ai/coding/v1/usages');
  });

  it('reports the preferred credential error when every credential is rejected', async () => {
    const fetchImpl = async (_url, init) => new Response('{}', {
      status: init.headers.Authorization === 'Bearer stale-key' ? 401 : 403,
    });

    const result = await fetchQuota({
      readAuth: () => ({
        'kimi-for-coding': { key: 'stale-key' },
        'kimi-code-plan-global': { key: 'another-stale-key' },
      }),
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API error: 401');
  });

  it('tries each distinct key only once when aliases repeat it', async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push({ url, authorization: init.headers.Authorization });
      return new Response('{}', { status: 401 });
    };

    const result = await fetchQuota({
      readAuth: () => ({
        'kimi-for-coding': { key: 'shared-key' },
        kimi: { key: 'shared-key' },
      }),
      fetchImpl,
    });

    expect(result.error).toBe('API error: 401');
    expect(urls.map((call) => call.authorization)).toEqual(['Bearer shared-key', 'Bearer shared-key']);
  });

  it('stays configured when only a later alias holds a usable key', async () => {
    const auth = { 'kimi-for-coding': { key: '   ' }, 'kimi-code-plan-global': { key: 'live-key' } };

    expect(isConfigured(auth)).toBe(true);
  });

  it('tries a repeated key at both regional endpoints', async () => {
    const urls = [];
    const result = await fetchQuota({
      readAuth: () => ({ 'kimi-code-plan-cn': { key: 'shared-key' }, 'kimi-code-plan-global': { key: 'shared-key' } }),
      fetchImpl: async (url) => {
        urls.push(url);
        return url === 'https://api.kimi.ai/coding/v1/usages'
          ? Response.json({ usages: { limit_5h: { used_ratio: 0.25 } } })
          : new Response(null, { status: 401 });
      },
    });
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
    expect(urls).toEqual(['https://api.kimi.com/coding/v1/usages', 'https://api.moonshot.ai/v1/users/me/balance', 'https://api.kimi.ai/coding/v1/usages']);
  });

  for (const status of [429, 500]) {
    it(`does not switch accounts after HTTP ${status}`, async () => {
      let requests = 0;
      const result = await fetchQuota({
        readAuth: () => ({ 'kimi-for-coding': { key: 'first' }, kimi: { key: 'second' } }),
        fetchImpl: async () => {
          requests += 1;
          return requests === 1 ? new Response(null, { status }) : Response.json({ usage: { limit: 100, used: 25 } });
        },
      });
      expect(requests).toBe(1);
      expect(result.error).toBe(`API error: ${status}`);
      expect(result.usage).toBeNull();
    });
  }

  for (const failure of ['transport', 'json']) {
    it(`does not switch accounts after a ${failure} failure`, async () => {
      let requests = 0;
      const result = await fetchQuota({
        readAuth: () => ({ 'kimi-for-coding': { key: 'first' }, kimi: { key: 'second' } }),
        fetchImpl: async () => {
          requests += 1;
          if (failure === 'transport') throw new Error('Connection failed');
          return new Response('{');
        },
      });
      expect(requests).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.usage).toBeNull();
    });
  }

  it('returns a successful Moonshot balance before trying another credential', async () => {
    const keys = [];
    const result = await fetchQuota({
      readAuth: () => ({ 'kimi-for-coding': { key: 'first' }, kimi: { key: 'second' } }),
      fetchImpl: async (url, init) => {
        keys.push(init.headers.Authorization);
        return url === 'https://api.moonshot.ai/v1/users/me/balance'
          ? Response.json({ data: { available_balance: 5 } })
          : new Response(null, { status: 403 });
      },
    });
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$5.00');
    expect(keys).toEqual(['Bearer first', 'Bearer first']);
  });

  it.each(['probe', 'refresh', 'usage'])('honors the %s deadline during body reads', async (expired) => {
    const deadlines = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    });
    try {
      const result = await fetchQuota({
        readAuth: () => ({ 'kimi-for-coding': { key: 'first' }, kimi: { key: 'second' } }),
        fetchImpl: async (url, init) => {
          if (expired === 'usage' || url === 'https://api.moonshot.ai/v1/users/me/balance') {
            return new Response(new ReadableStream({ start(controller) {
              init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
              deadlines[expired === 'refresh' ? 0 : expired === 'usage' ? 1 : 2].controller.abort(new DOMException('Timed out', 'TimeoutError'));
            } }));
          }
          return init.headers.Authorization === 'Bearer first'
            ? new Response(null, { status: 401 })
            : Response.json({ usage: { limit: 100, used: 25 } });
        },
      });
      if (expired === 'probe') {
        expect(result.usage.windows.weekly.usedPercent).toBe(25);
        expect(deadlines.map(({ ms }) => ms)).toEqual([25_000, 5_000, 5_000, 5_000]);
      } else {
        expect(result.ok).toBe(false);
        expect(result.usage).toBeNull();
        expect(deadlines.map(({ ms }) => ms)).toEqual(expired === 'usage' ? [25_000, 5_000] : [25_000, 5_000, 5_000]);
      }
    } finally {
      timeout.mockRestore();
    }
  });

  it('shows the pay-as-you-go balance when the Kimi Code address refuses a platform key', async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push({ url, authorization: init.headers.Authorization });
      return url === 'https://api.moonshot.ai/v1/users/me/balance'
        ? Response.json({ code: 0, data: { available_balance: 12.345 }, status: true })
        : new Response('{}', { status: 401 });
    };

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(urls.map((call) => call.url)).toEqual([
      'https://api.kimi.com/coding/v1/usages',
      'https://api.moonshot.ai/v1/users/me/balance',
    ]);
    expect(urls[1].authorization).toBe('Bearer test-token');
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('kimi-for-coding');
    expect(result.providerName).toBe('Kimi for Coding');
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$12.35');
  });

  it('keeps the original 401 when the balance read fails too', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return new Response('{}', { status: 401 });
    };

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(urls).toEqual(['https://api.kimi.com/coding/v1/usages', 'https://api.moonshot.ai/v1/users/me/balance']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 401');
  });

  it('treats a 403 from the Kimi Code address like a 401', async () => {
    const fetchImpl = async (url) => (
      url === 'https://api.moonshot.ai/v1/users/me/balance'
        ? Response.json({ data: { available_balance: 5 } })
        : new Response('{}', { status: 403 })
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$5.00');
  });

  it('does not try the balance address for errors other than authorisation', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return new Response('{}', { status: 500 });
    };

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(urls).toEqual(['https://api.kimi.com/coding/v1/usages']);
    expect(result.error).toBe('API error: 500');
  });

  describe('ratio-based usages payload', () => {
    // Captured live from GET https://api.kimi.com/coding/v1/usages on
    // 2026-10-08. Migrated plans answer with a ratio-based `usages` map instead
    // of the counted `usage` block, and keep a coarser `limits[]` entry for the
    // same 5-hour window. `limit_month_code` is the code-typed share of
    // `limit_month_total`, not a second allowance, and is not shown.
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

    const run = (body) => fetchQuota({ readAuth, fetchImpl: async () => mockResponse(body) });

    it('reads the 5h and monthly ratios and ignores the duplicate limits[] entry', async () => {
      const result = await run(migratedPlan);

      expect(result.ok).toBe(true);
      expect(Object.keys(result.usage.windows)).toEqual(['5h', 'monthly']);
      expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(49.5422, 9);
      expect(result.usage.windows['5h'].windowSeconds).toBe(18000);
      expect(result.usage.windows['5h'].resetAt).toBe(Date.parse('2026-10-08T11:50:22Z'));
    });

    it('reports the monthly row as a plain percent so it follows the used/remaining setting', async () => {
      const result = await run(migratedPlan);

      expect(result.usage.windows.monthly.usedPercent).toBeCloseTo(26.36, 9);
      expect(result.usage.windows.monthly.remainingPercent).toBeCloseTo(73.64, 9);
      expect(result.usage.windows.monthly.valueLabel).toBeUndefined();
      expect(result.usage.windows.monthly.windowSeconds).toBeNull();
      expect(result.usage.windows.monthly.resetAt).toBe(Date.parse('2026-10-18T00:00:00Z'));
    });

    it('maps limit_7d to the weekly window when the plan still serves it', async () => {
      const result = await run({ usages: { limit_7d: { used_ratio: 0.25, reset_time: null } } });

      expect(result.usage.windows.weekly.usedPercent).toBe(25);
      expect(result.usage.windows.weekly.windowSeconds).toBe(604800);
      expect(result.usage.windows.weekly.valueLabel).toBeUndefined();
    });

    it('keeps a zero ratio and skips an entry without one', async () => {
      const result = await run({
        usages: {
          limit_5h: { used_ratio: 0, reset_time: null },
          limit_month_total: { used_ratio: 'not-a-number', reset_time: null }
        }
      });

      expect(result.usage.windows['5h'].usedPercent).toBe(0);
      expect(Object.keys(result.usage.windows)).toEqual(['5h']);
    });
  });

  describe('credential lookup', () => {
    const sentKey = async (auth) => {
      let authorization;
      const fetchImpl = async (_url, init) => {
        authorization = init.headers.Authorization;
        return mockResponse({ usage: null, limits: [] });
      };
      const result = await fetchQuota({ readAuth: () => auth, fetchImpl });
      return { result, authorization };
    };

    it('finds a China plan credential stored under kimi-code-plan-cn', async () => {
      const auth = { 'kimi-code-plan-cn': { type: 'api', key: 'cn-key' } };

      const { result, authorization } = await sentKey(auth);

      expect(isConfigured(auth)).toBe(true);
      expect(result.ok).toBe(true);
      expect(authorization).toBe('Bearer cn-key');
    });

    it('prefers the China plan credential over a leftover pre-split kimi-for-coding key', async () => {
      const { authorization } = await sentKey({
        'kimi-for-coding': { type: 'api', key: 'stale-key' },
        kimi: { type: 'api', key: 'older-key' },
        'kimi-code-plan-cn': { type: 'api', key: 'cn-key' },
      });

      expect(authorization).toBe('Bearer cn-key');
    });

    it('still reads the global plan and the pre-split ids when they are the only credential', async () => {
      expect((await sentKey({ 'kimi-code-plan-global': { key: 'global-key' } })).authorization).toBe('Bearer global-key');
      expect((await sentKey({ 'kimi-for-coding': { key: 'legacy-key' } })).authorization).toBe('Bearer legacy-key');
    });

    it('keeps a pre-split key ahead of the global plan, as before', async () => {
      const { authorization } = await sentKey({
        'kimi-code-plan-global': { key: 'global-key' },
        'kimi-for-coding': { key: 'legacy-key' },
      });

      expect(authorization).toBe('Bearer legacy-key');
    });
  });
});
