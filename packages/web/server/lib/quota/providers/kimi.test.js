import { describe, expect, it } from 'vitest';

import { fetchQuota, isConfigured } from './kimi.js';

const readAuth = () => ({ 'kimi-for-coding': { key: 'test-token' } });

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

describe('Kimi for Coding quota provider', () => {
  it('computes weekly usedPercent from the used field (live API shape, no remaining field)', async () => {
    // Captured from GET https://api.kimi.com/coding/v1/usages — the weekly
    // `usage` block only ever includes `used`, never `remaining`.
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
