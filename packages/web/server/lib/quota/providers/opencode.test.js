import { describe, expect, it, vi } from 'vitest';

import {
  fetchQuota,
  isConfigured,
  parseConsoleBudget,
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

// The shape `/usage/summary` returns. It counts the whole Console workspace and
// has no provider breakdown, so it must not feed the Zen card.
const summaryPayload = (requests) => JSON.stringify({
  totalRequests: String(requests),
  totalInputTokens: '100',
  totalOutputTokens: '50',
  totalCacheReadTokens: '10',
  totalCostMicroCents: '0',
  services: [],
});

const budgetPayload = (rows = [{
  scope: 'service-account',
  serviceAccountId: 'svcacct_01TEST',
  name: 'Test service account',
  limitMicroCents: null,
  spentMicroCents: '0',
  exceeded: false,
  resetsAt: '2026-11-01T00:00:00.000Z',
}]) => JSON.stringify(rows);

const modelRow = (model, provider, requests) => ({ model, provider, totalRequests: String(requests) });
const zenModel = (model, requests) => modelRow(model, 'opencode', requests);
const goModel = (model, requests) => modelRow(model, 'opencode-go', requests);

const modelsPage = (items, page = 1, pageCount = 1) => JSON.stringify({
  items,
  pageInfo: { page, pageSize: 50, total: items.length, pageCount },
});

const modelsUrl = (range, page = 1) => `${CONSOLE_API_BASE}/usage/models?range=${range}&page=${page}&pageSize=50`;

/**
 * A Console that answers each range with its own model rows. The window totals
 * are the sums of the rows; `/usage/summary` reported the same aggregate in the
 * live check.
 */
const consoleFetch = ({
  daily = [zenModel('big-pickle', 292)],
  weekly = [zenModel('big-pickle', 3155)],
  monthly = [zenModel('big-pickle', 6979), zenModel('minimax-m3.1-flash-free', 6108)],
  budget = budgetPayload(),
} = {}) => vi.fn(async (url) => {
  if (url === modelsUrl('24h')) return new Response(modelsPage(daily));
  if (url === modelsUrl('7d')) return new Response(modelsPage(weekly));
  if (url === modelsUrl('30d')) return new Response(modelsPage(monthly));
  if (url === `${CONSOLE_API_BASE}/budgets/service-accounts/status`) return new Response(budget);
  return new Response('{}', { status: 404 });
});

describe('OpenCode Zen quota provider', () => {
  it('keeps every budget scoped to its service account, separate from the Zen counters', async () => {
    const budget = JSON.stringify([
      { serviceAccountId: 'svcacct_A', name: 'Build', spentMicroCents: '100000000', limitMicroCents: '1000000000' },
      { serviceAccountId: 'svcacct_B', name: 'Review', spentMicroCents: '900000000', limitMicroCents: null },
    ]);
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: consoleFetch({ budget }) });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 13087 });
    expect(result.usage.windows['Build (svcacct_A)'].value).toEqual({ kind: 'spend', spent: 1, limit: 10 });
    expect(result.usage.windows['Review (svcacct_B)'].value).toEqual({ kind: 'spend', spent: 9, limit: null });
  });

  it('reads every model page for each range and sums only the Zen rows', async () => {
    const perPage = { '24h': 1, '7d': 10, '30d': 100 };
    const pageFor = (range, page) => Response.json({
      items: [zenModel(`model-${range}-${page}`, perPage[range] * page), goModel(`go-${range}-${page}`, 1000 * page)],
      pageInfo: { page, pageCount: 2 },
    });
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/usage/models')) {
        const parsed = new URL(url);
        return pageFor(parsed.searchParams.get('range'), Number(parsed.searchParams.get('page')));
      }
      if (url === `${CONSOLE_API_BASE}/budgets/service-accounts/status`) return new Response('[]');
      return new Response('{}', { status: 404 });
    });

    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });

    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 3 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 30 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 300 });
    expect(Object.keys(result.usage.models)).toEqual(['model-30d-1', 'model-30d-2']);
    const pages = {};
    for (const [url] of fetchImpl.mock.calls) {
      if (!url.includes('/usage/models')) continue;
      const parsed = new URL(url);
      const range = parsed.searchParams.get('range');
      (pages[range] ??= []).push(Number(parsed.searchParams.get('page')));
    }
    expect(pages).toEqual({ '24h': [1, 2], '7d': [1, 2], '30d': [1, 2] });
  });

  it('drops a range whose later model page is unreadable', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (!url.includes('/usage/models')) return new Response('[]');
      const parsed = new URL(url);
      const range = parsed.searchParams.get('range');
      const page = Number(parsed.searchParams.get('page'));
      if (page === 1) {
        return Response.json({ items: [zenModel(`${range}-1`, 10)], pageInfo: { page: 1, pageCount: 2 } });
      }
      if (range === '30d') return new Response('null');
      return Response.json({ items: [zenModel(`${range}-2`, 5)], pageInfo: { page: 2, pageCount: 2 } });
    });

    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 15 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 15 });
    expect(result.usage.windows.monthly).toBeUndefined();
    expect(result.usage.models).toBeUndefined();
  });

  it('drops a range whose full first page has no usable pagination', async () => {
    const valid = consoleFetch({ budget: '[]' });
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: (url) => url.includes('range=24h')
        ? Promise.resolve(Response.json({
          items: Array.from({ length: 50 }, (_, index) => zenModel(`model-${index}`, 1)),
        }))
        : valid(url),
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily).toBeUndefined();
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 3155 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 13087 });
  });

  it.each(['null', '"invalid"', '', '{'])('keeps the other ranges when one range body is unusable %j', async (body) => {
    const valid = consoleFetch({ budget: '[]' });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: (url) =>
      url.includes('range=24h') ? Promise.resolve(new Response(body)) : valid(url) });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily).toBeUndefined();
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 3155 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 13087 });
  });

  it.each(['null', '"invalid"', '', '{'])('fails when every range is unusable %j', async (body) => {
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: async () => new Response(body) });
    expect(result).toMatchObject({ ok: false, configured: true, error: 'OpenCode Zen usage data could not be parsed' });
  });

  it('rejects invalid budget rows while keeping a valid zero', () => {
    expect(parseConsoleBudget([null, 'invalid', { spentMicroCents: ' ' }, { serviceAccountId: 'svcacct_test', spentMicroCents: '0' }])[0].spent).toBe(0);
    expect(parseConsoleBudget([{ serviceAccountId: 'svcacct_test', spentMicroCents: '0', limitMicroCents: null }])[0]).toMatchObject({ spent: 0, limit: null });
    expect(parseConsoleBudget([{ spentMicroCents: '100000000' }])).toEqual([]);
    expect(parseConsoleBudget([])).toEqual([]);
    expect(parseConsoleBudget(null)).toEqual([]);
  });

  it('keeps a zero request count as valid data', async () => {
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: consoleFetch({
        daily: [zenModel('zero', 0)],
        weekly: [zenModel('zero', 0)],
        monthly: [zenModel('zero', 0)],
      }),
    });
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 0 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 0 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 0 });
    expect(result.usage.models.zero.windows.monthly.value).toEqual({ kind: 'requests', count: 0 });
  });

  it.each(['', ' ', '\t', '-1', 'not-a-number'])('fails when every range has invalid numeric data %j', async (value) => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/usage/models')) {
        return Response.json({ items: [zenModel('invalid', value), zenModel('valid', 0)], pageInfo: { pageCount: 1 } });
      }
      return new Response('[]');
    });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result).toMatchObject({ ok: false, configured: true, error: 'OpenCode Zen usage data could not be parsed' });
  });

  it('drops only the range with invalid numeric data', async () => {
    const valid = consoleFetch({ budget: '[]' });
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: (url) => url.includes('range=24h')
        ? Promise.resolve(Response.json({
          items: [zenModel('invalid', '-1'), zenModel('valid', 0)],
          pageInfo: { pageCount: 1 },
        }))
        : valid(url),
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily).toBeUndefined();
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 3155 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 13087 });
    expect(Object.keys(result.usage.models)).toEqual(['big-pickle', 'minimax-m3.1-flash-free']);
  });

  it('ignores malformed rows for other providers', async () => {
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: consoleFetch({
        daily: [zenModel('zen-free', 3), { model: 'go-model', provider: 'opencode-go', totalRequests: 'not-a-number' }],
        weekly: [zenModel('zen-free', 30)],
        monthly: [zenModel('zen-free', 300)],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 3 });
    expect(Object.keys(result.usage.models)).toEqual(['zen-free']);
  });

  it('drops a range whose row cannot be attributed to a provider', async () => {
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: consoleFetch({
        daily: [{ model: 'unknown', totalRequests: '5' }],
        weekly: [zenModel('zen-free', 30)],
        monthly: [zenModel('zen-free', 300)],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily).toBeUndefined();
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 30 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 300 });
  });

  it('reports the daily, weekly and monthly request counts from the model rows', async () => {
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: consoleFetch() });
    expect(result).toMatchObject({ providerId, providerName, ok: true, configured: true });
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 292 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 3155 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 13087 });
  });

  it('reports only the 30-day Zen models', async () => {
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl: consoleFetch() });
    expect(Object.keys(result.usage.models)).toEqual(['big-pickle', 'minimax-m3.1-flash-free']);
    expect(result.usage.models['big-pickle'].windows.monthly.value).toEqual({ kind: 'requests', count: 6979 });
    expect(result.usage.models['minimax-m3.1-flash-free'].windows.monthly.value).toEqual({ kind: 'requests', count: 6108 });
  });

  it('keeps OpenCode Go usage out of the Zen card', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const models = (items) => Response.json({ items, pageInfo: { page: 1, pageCount: 1 } });
      if (url === `${CONSOLE_API_BASE}/usage/summary?range=24h`) return new Response(summaryPayload(400));
      if (url === `${CONSOLE_API_BASE}/usage/summary?range=7d`) return new Response(summaryPayload(4_000));
      if (url === `${CONSOLE_API_BASE}/usage/summary?range=30d`) return new Response(summaryPayload(40_000));
      if (url === modelsUrl('24h')) return models([zenModel('zen-free', 3), goModel('go-model', 400)]);
      if (url === modelsUrl('7d')) return models([zenModel('zen-free', 30), goModel('go-model', 4_000)]);
      if (url === modelsUrl('30d')) return models([zenModel('zen-free', 300), goModel('go-model', 40_000)]);
      if (url === `${CONSOLE_API_BASE}/budgets/service-accounts/status`) return Response.json([]);
      return new Response('{}', { status: 404 });
    });

    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.daily.value).toEqual({ kind: 'requests', count: 3 });
    expect(result.usage.windows.weekly.value).toEqual({ kind: 'requests', count: 30 });
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'requests', count: 300 });
    expect(Object.keys(result.usage.models)).toEqual(['zen-free']);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('/usage/summary'))).toBe(false);
  });

  it('fails the refresh when one range request fails', async () => {
    const valid = consoleFetch({ budget: '[]' });
    const result = await fetchQuota({
      readAuth: async () => apiKeyAuth(),
      fetchImpl: (url) => url.includes('range=24h')
        ? Promise.resolve(new Response('', { status: 500 }))
        : valid(url),
    });
    expect(result).toMatchObject({ ok: false, error: 'OpenCode Zen usage API returned HTTP 500' });
  });

  it('fails when every range request fails', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/usage/models')) return new Response('', { status: 500 });
      return new Response('[]');
    });
    const result = await fetchQuota({ readAuth: async () => apiKeyAuth(), fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'OpenCode Zen usage API returned HTTP 500' });
  });

  it('uses the Console token and organization of a Console sign-in', async () => {
    const fetchImpl = vi.fn(async () => new Response(modelsPage([zenModel('model', 5)])));
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

  it('is configured by a key on the shared opencode integration', () => {
    expect(isConfigured(apiKeyAuth())).toBe(true);
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ opencode: { type: 'oauth', access: 'x', server: CONSOLE_SERVER, orgID: 'wrk_TEST' } })).toBe(true);
    expect(isConfigured({ opencode: { type: 'oauth', access: 'x', server: 'https://example.com', orgID: 'wrk_TEST' } })).toBe(false);
  });

  it('keeps the provider identity stable', () => {
    expect(providerId).toBe('opencode');
    expect(providerName).toBe('OpenCode Zen');
  });
});
