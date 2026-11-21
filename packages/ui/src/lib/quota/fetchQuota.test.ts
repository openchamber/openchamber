import { afterEach, expect, mock, test } from 'bun:test';
import type { ProviderResult } from '@/types';

let responsePayload: ProviderResult;
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => Response.json(responsePayload) }));
const { fetchQuota } = await import('./fetchQuota');

afterEach(() => mock.restore());

test('quota transport preserves structured Zen values for windows and models', async () => {
  const window = {
    usedPercent: null, remainingPercent: null, windowSeconds: null, resetAfterSeconds: null,
    resetAt: null, resetAtFormatted: null, resetAfterFormatted: null,
  };
  responsePayload = {
    providerId: 'opencode', providerName: 'OpenCode Zen', ok: true, configured: true, fetchedAt: 1,
    usage: {
      windows: {
        daily: { ...window, value: { kind: 'requests', count: 0 } },
        monthly: { ...window, value: { kind: 'spend', spent: 2, limit: 10 } },
      },
      models: { test: { windows: { monthly: { ...window, value: { kind: 'requests', count: 42 } } } } },
    },
  };
  const result = await fetchQuota('opencode');
  expect(result.usage?.windows.daily?.value).toEqual({ kind: 'requests', count: 0 });
  expect(result.usage?.windows.monthly?.value).toEqual({ kind: 'spend', spent: 2, limit: 10 });
  expect(result.usage?.models?.test?.windows.monthly?.value).toEqual({ kind: 'requests', count: 42 });
});

test('preserves semantic credits-used data through the quota response parser', async () => {
  const window = {
    usedPercent: null,
    remainingPercent: null,
    windowSeconds: null,
    resetAfterSeconds: null,
    resetAt: null,
    resetAtFormatted: null,
    resetAfterFormatted: null,
    creditsUsed: 0,
  };
  responsePayload = {
    providerId: 'github-copilot',
    providerName: 'GitHub Copilot',
    ok: true,
    configured: true,
    planLabel: 'Copilot Business',
    accountLabel: 'other@example.com',
    usage: { windows: { premium_interactions: window } },
    fetchedAt: 1,
  };

  const result = await fetchQuota('github-copilot');
  expect(result.usage?.windows.premium_interactions).toEqual(window);
  expect(result.planLabel).toBe('Copilot Business');
  expect(result.accountLabel).toBe('other@example.com');
});

test('preserves monthly spending totals and unknown category amounts through the parser', async () => {
  const window = {
    usedPercent: null,
    remainingPercent: null,
    windowSeconds: null,
    resetAfterSeconds: null,
    resetAt: null,
    resetAtFormatted: null,
    resetAfterFormatted: null,
  };
  responsePayload = {
    providerId: 'openrouter', providerName: 'OpenRouter', ok: true, configured: true, fetchedAt: 1,
    usage: {
      windows: {
        monthly_total: { ...window, value: { kind: 'spend', spent: 226.64374512, limit: null } },
        monthly_credits: { ...window, value: { kind: 'spend', spent: 14.297788398, limit: null } },
        monthly_byok: { ...window, value: { kind: 'spend', spent: null, limit: null } },
      },
    },
  };

  const result = await fetchQuota('openrouter');
  expect(result.usage?.windows.monthly_total?.value).toEqual({ kind: 'spend', spent: 226.64374512, limit: null });
  expect(result.usage?.windows.monthly_credits?.value).toEqual({ kind: 'spend', spent: 14.297788398, limit: null });
  expect(result.usage?.windows.monthly_byok?.value).toEqual({ kind: 'spend', spent: null, limit: null });
});

