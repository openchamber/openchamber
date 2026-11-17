import { describe, expect, test } from 'bun:test';

import { catalogCostUsdOf, createPlanMetricsReader, planMetricsOfSession, sessionTokensOf } from './plan-metrics.js';

const TOKENS = { input: 1_000_000, output: 500_000, reasoning: 100_000, cache: { read: 200_000, write: 100_000 } };
const TOKEN_TOTALS = { input: 1_000_000, output: 500_000, reasoning: 100_000, cacheRead: 200_000, cacheWrite: 100_000, total: 1_900_000 };
const CATALOG = {
  anthropic: {
    models: {
      'claude-sonnet-4-5': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
  },
};
const SESSION = { id: 'ses_1', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, tokens: TOKENS };

describe('sessionTokensOf', () => {
  test('normalizes the OpenCode token block into totals', () => {
    expect(sessionTokensOf(SESSION)).toEqual(TOKEN_TOTALS);
  });

  test('no token block is absence, not zeros', () => {
    expect(sessionTokensOf({ id: 'ses_1' })).toBeNull();
    expect(sessionTokensOf(null)).toBeNull();
  });
});

describe('planMetricsOfSession', () => {
  test('the OpenCode cost figure is authoritative and the catalog is not consulted', () => {
    expect(planMetricsOfSession({ ...SESSION, cost: 4.25 }, null)).toEqual({
      costUsd: 4.25,
      costSource: 'opencode',
      tokens: TOKEN_TOTALS,
    });
  });

  test('catalog pricing is the fallback for a session with no cost figure', () => {
    // 1M in @ $3 + (500k out + 100k reasoning) @ $15 + 200k cache read @ $0.30
    // + 100k cache write @ $3.75, all per 1M tokens.
    expect(planMetricsOfSession(SESSION, CATALOG)).toEqual({
      costUsd: 12.435,
      costSource: 'catalog',
      tokens: TOKEN_TOTALS,
    });
  });

  test('an unpriced model leaves cost unknown but keeps the tokens', () => {
    const session = { ...SESSION, model: { providerID: 'unknown', modelID: 'nope' } };
    expect(planMetricsOfSession(session, CATALOG)).toEqual({
      costUsd: null,
      costSource: null,
      tokens: TOKEN_TOTALS,
    });
  });

  test('a session with neither cost nor tokens has no metrics', () => {
    expect(planMetricsOfSession({ id: 'ses_1' }, CATALOG)).toBeNull();
    expect(planMetricsOfSession(null, CATALOG)).toBeNull();
  });

  test('catalogCostUsdOf folds the string model shape', () => {
    const session = { model: 'anthropic/claude-sonnet-4-5', tokens: TOKENS };
    expect(catalogCostUsdOf(CATALOG, session, sessionTokensOf(session))).toBe(12.435);
  });
});

describe('createPlanMetricsReader', () => {
  const readerWith = (session, loadCatalog, options = {}) => createPlanMetricsReader({
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: options.fetchImpl ?? (async (url) => {
      expect(url).toBe('http://opencode.test/api/session/ses_1');
      return session === null
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify({ data: session }), { status: 200 });
    }),
    loadCatalog,
    now: options.now,
  });

  test('reads the session record through the response envelope', async () => {
    let catalogCalls = 0;
    const reader = readerWith({ ...SESSION, cost: 1.5 }, async () => { catalogCalls += 1; return CATALOG; });
    expect(await reader('ses_1')).toEqual({ costUsd: 1.5, costSource: 'opencode', tokens: TOKEN_TOTALS });
    expect(catalogCalls).toBe(0);
  });

  test('fetches the catalog only when the session has tokens but no cost', async () => {
    const reader = readerWith(SESSION, async () => CATALOG);
    expect((await reader('ses_1'))?.costSource).toBe('catalog');
  });

  test('a missing session and a failed read both give no metrics', async () => {
    let missingFetches = 0;
    const missing = readerWith(null, async () => CATALOG, {
      fetchImpl: async () => { missingFetches += 1; return new Response(null, { status: 404 }); },
    });
    expect(await missing('ses_1')).toBeNull();
    expect(await missing('ses_1')).toBeNull();
    expect(missingFetches).toBe(2);

    let failedFetches = 0;
    const failing = createPlanMetricsReader({
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => { failedFetches += 1; throw new Error('unreachable'); },
      loadCatalog: async () => CATALOG,
    });
    expect(await failing('ses_1')).toBeNull();
    expect(await failing('ses_1')).toBeNull();
    expect(failedFetches).toBe(2);
    expect(await failing('')).toBeNull();
  });

  test('reuses successful metrics for 30 seconds and refreshes at expiry', async () => {
    let currentTime = 0;
    let fetchCalls = 0;
    const reader = readerWith({ ...SESSION, cost: 1.5 }, async () => CATALOG, {
      now: () => currentTime,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: { ...SESSION, cost: 1.5 } }), { status: 200 });
      },
    });

    expect(await reader('ses_1')).toEqual({ costUsd: 1.5, costSource: 'opencode', tokens: TOKEN_TOTALS });
    currentTime = 29_999;
    await reader('ses_1');
    expect(fetchCalls).toBe(1);

    currentTime = 30_000;
    await reader('ses_1');
    expect(fetchCalls).toBe(2);
  });

  test('shares one in-flight read for concurrent requests of the same session', async () => {
    let fetchCalls = 0;
    let finishFetch;
    const response = new Promise((resolve) => { finishFetch = resolve; });
    const reader = readerWith({ ...SESSION, cost: 1.5 }, async () => CATALOG, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return response;
      },
    });

    const first = reader('ses_1');
    const second = reader('ses_1');
    expect(fetchCalls).toBe(1);
    finishFetch(new Response(JSON.stringify({ data: { ...SESSION, cost: 1.5 } }), { status: 200 }));
    expect(await Promise.all([first, second])).toEqual([
      { costUsd: 1.5, costSource: 'opencode', tokens: TOKEN_TOTALS },
      { costUsd: 1.5, costSource: 'opencode', tokens: TOKEN_TOTALS },
    ]);
  });

  test('does not cache a partial result when catalog loading fails', async () => {
    let fetchCalls = 0;
    let catalogCalls = 0;
    const reader = readerWith(SESSION, async () => {
      catalogCalls += 1;
      throw new Error('catalog unavailable');
    }, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: SESSION }), { status: 200 });
      },
    });

    expect(await reader('ses_1')).toEqual({ costUsd: null, costSource: null, tokens: TOKEN_TOTALS });
    expect(await reader('ses_1')).toEqual({ costUsd: null, costSource: null, tokens: TOKEN_TOTALS });
    expect(fetchCalls).toBe(2);
    expect(catalogCalls).toBe(2);
  });

  test('bounds successful session entries to 500', async () => {
    let fetchCalls = 0;
    const reader = readerWith(null, async () => CATALOG, {
      fetchImpl: async (url) => {
        fetchCalls += 1;
        const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
        return new Response(JSON.stringify({ data: { id, cost: 1 } }), { status: 200 });
      },
    });

    for (let index = 0; index < 500; index += 1) await reader(`ses_${index}`);
    await reader('ses_new');
    await reader('ses_0');
    expect(fetchCalls).toBe(502);
  });
});
