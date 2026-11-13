import { describe, expect, it, vi } from 'vitest';

import {
  fetchQuota,
  isConfigured,
  parseConsoleBudget,
  parseConsoleModelUsage,
  parseConsoleSummary,
  providerId,
  providerName,
} from './opencode.js';

const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_API_BASE = 'https://opencode.ai/console/api';

const apiKeyAuth = () => ({ opencode: { type: 'api', key: 'zen-key' } });

const consoleAuth = (overrides = {}) => ({
  opencode: {
    type: 'oauth',
    access: 'console-access',
    refresh: 'console-refresh',
    expires: Date.now() + 3_600_000,
    server: CONSOLE_SERVER,
    orgID: 'wrk_TESTORG123',
    ...overrides,
  },
});

const summaryPayload = (requests) => JSON.stringify({
  totalRequests: String(requests),
  totalInputTokens: '100',
  totalOutputTokens: '50',
  totalCacheReadTokens: '10',
  totalCostMicroCents: '0',
  services: [],
});

const budgetPayload = () => JSON.stringify([{
  scope: 'service-account',
  serviceAccountId: 'svcacct_01TEST',
  name: 'Test service account',
  limitMicroCents: null,
  spentMicroCents: '0',
  exceeded: false,
  resetsAt: '2026-11-01T00:00:00.000Z',
}]);

const modelsPayload = () => JSON.stringify({
  items: [
    { model: 'big-pickle', provider: 'opencode', totalRequests: '6979', totalCostMicroCents: '0' },
    { model: 'minimax-m3.1-flash-free', provider: 'opencode', totalRequests: '6108', totalCostMicroCents: '0' },
  ],
  pageInfo: { page: 1, pageSize: 50, total: 2, pageCount: 1 },
});

/**
 * A Console that answers the usage endpoints with the given request counts.
 */
const consoleFetch = ({ daily = 292, weekly = 3155, monthly = 10802, budget = budgetPayload(), models = modelsPayload() } = {}) =>
  vi.fn(async (url) => {
    if (url === `${CONSOLE_API_BASE}/usage/summary?range=24h`) return new Response(summaryPayload(daily));
    if (url === `${CONSOLE_API_BASE}/usage/summary?range=7d`) return new Response(summaryPayload(weekly));
    if (url === `${CONSOLE_API_BASE}/usage/summary?range=30d`) return new Response(summaryPayload(monthly));
    if (url.startsWith(`${CONSOLE_API_BASE}/usage/models`)) return new Response(models);
    if (url === `${CONSOLE_API_BASE}/budgets/service-accounts/status`) return new Response(budget);
    return new Response('{}', { status: 404 });
  });

describe('OpenCode Zen quota provider', () => {
  it('keeps every budget scoped to its service account, separate from workspace counters', async () => {
    const budget = JSON.stringify([
      { serviceAccountId: 'svcacct_A', name: 'Build', spentMicroCents: '100000000', limitMicroCents: '1000000000' },
      { serviceAccountId: 'svcacct_B', name: 'Review', spentMicroCents: '900000000', limitMicroCents: null },
    ]);
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: consoleFetch({ budget }) });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 10802 });
    expect(result.usage.windows['Build (svcacct_A)'].value).toEqual({ kind: 'spend', spent: 1, limit: 10 });
    expect(result.usage.windows['Review (svcacct_B)'].value).toEqual({ kind: 'spend', spent: 9, limit: null });
  });

  it('reads models on every page and fails if a later page fails', async () => {
    const baseFetch = consoleFetch();
    let failSecondPage = false;
    const fetchImpl = vi.fn(async (url) => {
      if (!url.includes('/usage/models')) return baseFetch(url);
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 2 && failSecondPage) return new Response('', { status: 500 });
      return Response.json({ items: [{ model: `model-${page}`, totalRequests: String(page) }], pageInfo: { page, pageCount: 2 } });
    });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(Object.keys(result.usage.models)).toEqual(['model-1', 'model-2']);
    expect(result.usage.models['model-2'].windows.monthly.value).toEqual({ kind: 'requests', count: 2 });
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/usage/models'))).toHaveLength(2);
    failSecondPage = true;
    expect(await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl })).toMatchObject({ ok: false, error: 'OpenCode Zen usage API returned HTTP 500' });
  });

  it('rejects an unreadable later model page without returning a truncated list', async () => {
    const baseFetch = consoleFetch();
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: async (url) => {
      if (!url.includes('/usage/models')) return baseFetch(url);
      if (new URL(url).searchParams.get('page') === '2') return new Response('null');
      return Response.json({ items: [{ model: 'first', totalRequests: '1' }], pageInfo: { pageCount: 2 } });
    } });
    expect(result).toMatchObject({ ok: false, usage: null, error: 'OpenCode Zen model page could not be parsed' });
  });

  it.each(['', ' ', '\t', '-1', 'not-a-number'])('rejects missing or invalid numeric data %j without inventing zero', (value) => {
    expect(parseConsoleSummary({ totalRequests: value })).toBeNull();
    expect(parseConsoleBudget([{ serviceAccountId: 'svcacct_test', spentMicroCents: value }])).toEqual([]);
    expect(parseConsoleModelUsage({ items: [{ model: 'test', totalRequests: value }] })).toEqual({});
  });

  it.each(['null', '"invalid"', '', '{'])('keeps valid windows when one successful response has an unusable body %j', async (body) => {
    const validFetch = consoleFetch({ budget: '[]', models: '{}' });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: (url) =>
      url.includes('range=24h') ? Promise.resolve(new Response(body)) : validFetch(url) });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily).toBeUndefined();
    expect(result.usage.windows.weekly).toBeDefined();
  });

  it.each(['null', '"invalid"', '', '{'])('fails when every successful response is unusable %j', async (body) => {
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: async () => new Response(body) });
    expect(result).toMatchObject({ ok: false, configured: true, error: 'OpenCode Zen usage data could not be parsed' });
  });

  it('skips malformed budget rows while keeping a valid zero', () => {
    expect(parseConsoleBudget([null, 'invalid', { spentMicroCents: ' ' }, { serviceAccountId: 'svcacct_test', spentMicroCents: '0' }])[0].spent).toBe(0);
    expect(parseConsoleSummary({ totalRequests: '0' })).toEqual({ requests: 0 });
    expect(parseConsoleModelUsage({ items: [{ model: 'test', totalRequests: '0' }] })).toEqual({ test: { requests: 0 } });
  });

  it('reads the request counters of each range', () => {
    expect(parseConsoleSummary({ totalRequests: '42' })).toEqual({ requests: 42 });
    expect(parseConsoleSummary({ totalRequests: 42 })).toEqual({ requests: 42 });
    expect(parseConsoleSummary({ totalRequests: '-1' })).toBeNull();
    expect(parseConsoleSummary({})).toBeNull();
    expect(parseConsoleSummary(null)).toBeNull();
  });

  it('reads the service-account budget and treats a missing limit as uncapped', () => {
    const [budget] = parseConsoleBudget([{ serviceAccountId: 'svcacct_test', spentMicroCents: '0', limitMicroCents: null, resetsAt: '2026-11-01T00:00:00.000Z' }]);
    expect(budget.spent).toBe(0);
    expect(budget.limit).toBeNull();
    expect(budget.resetAt).toBe(Date.parse('2026-11-01T00:00:00.000Z'));

    const [capped] = parseConsoleBudget([{ serviceAccountId: 'svcacct_test', spentMicroCents: '250000000', limitMicroCents: '1000000000', resetsAt: '2026-11-01T00:00:00.000Z' }]);
    expect(capped.spent).toBe(2.5);
    expect(capped.limit).toBe(10);
    expect(parseConsoleBudget([])).toEqual([]);
    expect(parseConsoleBudget(null)).toEqual([]);
    expect(parseConsoleBudget([{ spentMicroCents: '100000000' }])).toEqual([]);
  });

  it('reads the per-model request counters', () => {
    const models = parseConsoleModelUsage({ items: [{ model: 'big-pickle', totalRequests: '6979' }, { model: '', totalRequests: '5' }, { totalRequests: '5' }] });
    expect(models).toEqual({ 'big-pickle': { requests: 6979 } });
    expect(parseConsoleModelUsage({})).toEqual({});
  });

  it('is configured by a key on the shared opencode integration', () => {
    expect(isConfigured(apiKeyAuth())).toBe(true);
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ opencode: { type: 'oauth', access: 'x', server: CONSOLE_SERVER, orgID: 'wrk_TEST' } })).toBe(true);
    expect(isConfigured({ opencode: { type: 'oauth', access: 'x', server: 'https://example.com', orgID: 'wrk_TEST' } })).toBe(false);
  });

  it('reports the daily, weekly and monthly windows with the request counts', async () => {
    const fetchImpl = consoleFetch();
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result).toMatchObject({ providerId: 'opencode', providerName: 'OpenCode Zen', ok: true, configured: true });
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 292 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 3155 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 10802 });
    expect(result.usage.windows['Test service account (svcacct_01TEST)'].value).toEqual({ kind: 'spend', spent: 0, limit: null });
    expect(result.usage.windows['Test service account (svcacct_01TEST)'].resetAt).toBe(Date.parse('2026-11-01T00:00:00.000Z'));
  });

  it('reports the models that served the requests', async () => {
    const fetchImpl = consoleFetch();
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result.usage.models['big-pickle'].windows.monthly.value).toEqual({ kind: 'requests', count: 6979 });
    expect(result.usage.models['minimax-m3.1-flash-free'].windows.monthly.value).toEqual({ kind: 'requests', count: 6108 });
  });

  it('falls back to the monthly request count when the workspace has no budget', async () => {
    const fetchImpl = consoleFetch({ budget: '[]' });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 10802 });
  });

  it('fails when the model list fails', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith(`${CONSOLE_API_BASE}/usage/models`)) return new Response('', { status: 500 });
      if (url === `${CONSOLE_API_BASE}/budgets/service-accounts/status`) return new Response(budgetPayload());
      if (url.includes('range=24h')) return new Response(summaryPayload(10));
      if (url.includes('range=7d')) return new Response(summaryPayload(20));
      return new Response(summaryPayload(30));
    });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('OpenCode Zen usage API returned HTTP 500');
  });

  it('uses the Console token and organization of a Console sign-in', async () => {
    const fetchImpl = consoleFetch();
    const result = await fetchQuota({ readAuth: async () => consoleAuth(), fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer console-access');
    expect(fetchImpl.mock.calls[0][1].headers['x-org-id']).toBe('wrk_TESTORG123');
  });

  it('uses the workspace key of the shared opencode integration', async () => {
    const fetchImpl = consoleFetch();
    await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer zen-key');
    expect(fetchImpl.mock.calls[0][1].headers['x-org-id']).toBeUndefined();
  });

  it('never forwards the credential to another origin', async () => {
    const fetchImpl = consoleFetch();
    await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].redirect).toBe('error');
      expect(call[0].startsWith(CONSOLE_API_BASE)).toBe(true);
    }
  });

  it('reports a rejected credential as an authentication failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result).toMatchObject({ ok: false, configured: true, error: 'OpenCode Zen authentication failed' });
  });

  it('reports a workspace without a credential as not configured', async () => {
    const result = await fetchQuota({ readAuth: async () => ({}) });
    expect(result).toMatchObject({ ok: false, configured: false, error: 'Not configured' });
  });

  it('keeps the provider identity stable', () => {
    expect(providerId).toBe('opencode');
    expect(providerName).toBe('OpenCode Zen');
  });
});
