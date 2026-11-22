import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IMPORT_REQUIRED_ERROR,
  SESSION_EXPIRED_ERROR,
  fetchOpenDesignQuota,
  fetchQuota,
  parseCodingPlanWindows,
  parseUsageBreakdown
} from './opendesign.js';
import { normalizers } from '../credentials/providers.js';

const credential = { cookie: 'better-auth.session_token=test-session', workspaceId: 'ws_123' };

const windowsPayload = {
  windows: [
    { policyId: 'go', durationSeconds: 18000, limitCredits: 10, remainingCredits: 7.5, resetsAt: '2026-10-25T22:14:00Z' },
    { policyId: 'go', durationSeconds: 604800, limitCredits: 30, remainingCredits: 30, resetsAt: null },
    { policyId: 'other', durationSeconds: 86400, limitCredits: 5, remainingCredits: 5, resetsAt: null }
  ]
};

const usagePayload = {
  records: [
    { model: 'claude-haiku', inputTokens: 1000, outputTokens: 500, credits: 3, multiplier: 2 },
    { model: 'deepseek-v4-flash', input_tokens: 2000, output_tokens: 1000, credits_used: 1.5, credit_multiplier: 1 },
    { model: 'claude-haiku', inputTokens: 500, outputTokens: 250, credits: 1.5, multiplier: 2 }
  ]
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Open Design coding plan windows', () => {
  it('maps the 5h and 7d windows with used percent from remaining credits', () => {
    const windows = parseCodingPlanWindows(windowsPayload);
    expect(Object.keys(windows ?? {})).toEqual(['5h', '7d']);
    expect(windows?.['5h'].usedPercent).toBeCloseTo(25);
    expect(windows?.['5h'].windowSeconds).toBe(18000);
    expect(windows?.['5h'].resetAt).toBe(Date.parse('2026-10-25T22:14:00Z'));
    expect(windows?.['5h'].valueLabel).toBe('7.5 / 10 credits');
    expect(windows?.['7d'].usedPercent).toBeCloseTo(0);
    expect(windows?.['7d'].resetAt).toBeNull();
  });

  it('answers null for payloads without usable windows', () => {
    expect(parseCodingPlanWindows(null)).toBeNull();
    expect(parseCodingPlanWindows({})).toBeNull();
    expect(parseCodingPlanWindows({ windows: [{ durationSeconds: 18000, limitCredits: 'x', remainingCredits: 1 }] })).toBeNull();
  });
});

describe('Open Design usage breakdown', () => {
  it('aggregates records per model with credits, tokens, multiplier, and share', () => {
    const models = parseUsageBreakdown(usagePayload);
    expect(models).toHaveLength(2);
    const [haiku, flash] = models ?? [];
    expect(haiku.model).toBe('claude-haiku');
    expect(haiku.credits).toBeCloseTo(4.5);
    expect(haiku.inputTokens).toBe(1500);
    expect(haiku.outputTokens).toBe(750);
    expect(haiku.totalTokens).toBe(2250);
    expect(haiku.multiplier).toBe(2);
    expect(haiku.sharePercent).toBeCloseTo(75);
    expect(flash.model).toBe('deepseek-v4-flash');
    expect(flash.credits).toBeCloseTo(1.5);
    expect(flash.totalTokens).toBe(3000);
    expect(flash.sharePercent).toBeCloseTo(25);
  });

  it('answers null when no record names a model', () => {
    expect(parseUsageBreakdown(null)).toBeNull();
    expect(parseUsageBreakdown({ records: [] })).toBeNull();
    expect(parseUsageBreakdown({ records: [{ credits: 1 }] })).toBeNull();
  });
});

describe('Open Design fetch', () => {
  const fakeFetch = (handlers) => {
    const requests = [];
    const impl = async (url, init = {}) => {
      const href = String(url);
      requests.push({ url: href, headers: init.headers });
      if (href.includes('/auth/get-session')) return handlers.session();
      if (href.includes('coding-plan-usage')) return handlers.usage();
      if (href.includes('/billing/usage')) return handlers.breakdown();
      throw new Error(`Unexpected URL ${href}`);
    };
    return { impl, requests };
  };

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

  it('reads the session, windows, and breakdown with the stored cookie', async () => {
    const { impl, requests } = fakeFetch({
      session: () => okJson({ user: { id: 'u1' }, session: { id: 's1' } }),
      usage: () => okJson(windowsPayload),
      breakdown: () => okJson(usagePayload)
    });

    const usage = await fetchOpenDesignQuota(credential, impl);
    expect(usage.windows['5h'].usedPercent).toBeCloseTo(25);
    expect(usage.models).toHaveLength(2);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.Cookie).toBe(credential.cookie);
      expect(request.headers['x-vela-workspace-id']).toBe('ws_123');
    }
    expect(requests[1].url).toContain('/v1/workspaces/ws_123/billing/coding-plan-usage');
  });

  it('reports an expired session instead of zeros', async () => {
    const { impl } = fakeFetch({
      session: () => okJson(null),
      usage: () => okJson(windowsPayload),
      breakdown: () => okJson(usagePayload)
    });
    await expect(fetchOpenDesignQuota(credential, impl)).rejects.toThrow(SESSION_EXPIRED_ERROR);
  });

  it('reports a 401 from the usage endpoint as an expired session', async () => {
    const { impl } = fakeFetch({
      session: () => okJson({ user: { id: 'u1' } }),
      usage: () => ({ ok: false, status: 401, json: async () => ({}) }),
      breakdown: () => okJson(usagePayload)
    });
    await expect(fetchOpenDesignQuota(credential, impl)).rejects.toThrow(SESSION_EXPIRED_ERROR);
  });

  it('keeps the windows when the breakdown read fails', async () => {
    const { impl } = fakeFetch({
      session: () => okJson({ user: { id: 'u1' } }),
      usage: () => okJson(windowsPayload),
      breakdown: () => ({ ok: false, status: 500, json: async () => ({}) })
    });
    const usage = await fetchOpenDesignQuota(credential, impl);
    expect(usage.windows['7d'].usedPercent).toBeCloseTo(0);
    expect(usage.models).toBeUndefined();
  });

  it('asks for the cookie import when no credential is stored', async () => {
    vi.stubEnv('OPENCHAMBER_DATA_DIR', '/tmp/opendesign-test-without-credentials');
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe(IMPORT_REQUIRED_ERROR);
  });
});

describe('Open Design credential normalizer', () => {
  it('stores a bare session token under its cookie name', () => {
    expect(normalizers.opendesign({ cookie: 'token-value', workspaceId: 'ws_1' }))
      .toEqual({ cookie: 'better-auth.session_token=token-value', workspaceId: 'ws_1' });
  });

  it('keeps a copied cookie header as it is', () => {
    const header = 'better-auth.session_token=abc; other=1';
    expect(normalizers.opendesign({ cookie: header, workspaceId: 'ws_1' }))
      .toEqual({ cookie: header, workspaceId: 'ws_1' });
  });

  it('rejects incomplete credentials', () => {
    expect(normalizers.opendesign({ cookie: 'x' })).toBeNull();
    expect(normalizers.opendesign({ workspaceId: 'ws_1' })).toBeNull();
    expect(normalizers.opendesign({ cookie: 'a\r\nb', workspaceId: 'ws_1' })).toBeNull();
  });
});
