import { describe, expect, it } from 'bun:test';
import { fetchOllamaCloudPlan, fetchOllamaCloudUsage, toUsageWindows } from './ollama-cloud.js';

const PERIOD = { from: '2026-09-28T20:49:41Z', until: '2026-10-28T20:49:41Z' };
const pool = (allowance_usd, balance_usd, period = PERIOD) => ({ allowance_usd, balance_usd, period });

const keyed = (apiKey) => async (url, init) => {
  expect(url).toBe('https://ollama.com/api/balance');
  expect(init.method).toBe('GET');
  expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${apiKey}`);
  return new Response(JSON.stringify({ included: pool(60, 50.12376), purchased: { balance_usd: 0 } }));
};

describe('Ollama Cloud quota provider', () => {
  it('authenticates with the API key OpenCode stores, never a cookie', async () => {
    const windows = await fetchOllamaCloudUsage('test-key', keyed('test-key'));
    expect(windows.monthly.usedPercent).toBeCloseTo(16.4604, 4);
    // The key must never come back through the result.
    expect(JSON.stringify(windows).includes('test-key')).toBe(false);
  });

  it('maps the monthly credit pool to a percentage with the reset time', () => {
    const windows = toUsageWindows({ included: pool(60, 50.12376) });
    expect(windows.monthly.usedPercent).toBeCloseTo(16.4604, 4);
    expect(windows.monthly.remainingPercent).toBeCloseTo(83.5396, 4);
    expect(windows.monthly.resetAt).toBe(Date.parse('2026-10-28T20:49:41Z'));
  });

  it('reads the plan tier, best-effort, from POST /api/me', async () => {
    const plan = await fetchOllamaCloudPlan('key', async (url, init) => {
      expect(url).toBe('https://ollama.com/api/me');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer key');
      return new Response(JSON.stringify({ Plan: 'free' }));
    });
    expect(plan).toBe('free');

    expect(await fetchOllamaCloudPlan('key', async () => new Response('', { status: 500 }))).toBe(null);
  });

  it('reports an auth failure for a rejected key', async () => {
    await expect(fetchOllamaCloudUsage('bad-key', async () => new Response('{"error":"invalid credentials"}', { status: 401 })))
      .rejects.toThrow('authentication failed');
    await expect(fetchOllamaCloudUsage('bad-key', async () => new Response('', { status: 403 })))
      .rejects.toThrow('authentication failed');
  });

  it('does not call a server error an auth failure', async () => {
    await expect(fetchOllamaCloudUsage('key', async () => new Response('', { status: 503 })))
      .rejects.toThrow('returned HTTP 503');
  });

  it('reports an unreadable body as such, not as a missing usage shape', async () => {
    await expect(fetchOllamaCloudUsage('key', async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }))).rejects.toThrow('Unexpected token');
  });

  it('reads a balance that arrives as a numeric string', () => {
    expect(toUsageWindows({ included: pool('60', '50.12376') }).monthly.usedPercent).toBeCloseTo(16.4604, 4);
  });

  it('clamps a pool at or over its cap to 100', () => {
    expect(toUsageWindows({ included: pool(60, 0) }).monthly.usedPercent).toBe(100);
    expect(toUsageWindows({ included: pool(60, -5) }).monthly.usedPercent).toBe(100);
  });

  it('omits the reset when the payload carries no period', () => {
    expect(toUsageWindows({ included: { allowance_usd: 60, balance_usd: 30 } }).monthly.resetAt).toBe(null);
  });

  it('maps a legacy plan session and weekly limit into windows', () => {
    // A legacy plan reports remaining_percent rather than a dollar pool.
    const windows = toUsageWindows({
      included: {
        session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
        weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
      },
      purchased: { balance_usd: 25 },
    });
    expect(Object.keys(windows)).toEqual(['session', 'weekly', 'purchased_credits']);
    expect(windows.session.usedPercent).toBe(25);
    expect(windows.session.resetAt).toBe(Date.parse('2026-10-01T07:00:00Z'));
    expect(windows.weekly.usedPercent).toBe(60);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-10-05T00:00:00Z'));
    expect(windows.purchased_credits.valueLabel).toBe('$25.00');
  });

  it('clamps and skips an unusable legacy limit', () => {
    const windows = toUsageWindows({ included: { session: { remaining_percent: 140 }, weekly: { remaining_percent: -5 } } });
    expect(windows.session.usedPercent).toBe(0);
    expect(windows.weekly.usedPercent).toBe(100);
    expect(toUsageWindows({ included: { session: {} } })).toEqual({});
  });

  it('shows purchased credit only while it is positive', () => {
    const withCredit = toUsageWindows({ included: pool(60, 30), purchased: { balance_usd: 12.5 } });
    expect(Object.keys(withCredit)).toEqual(['monthly', 'purchased_credits']);
    expect(withCredit.purchased_credits.valueLabel).toBe('$12.50');
    expect(withCredit.purchased_credits.usedPercent).toBe(null);

    expect(Object.keys(toUsageWindows({ included: pool(60, 30), purchased: { balance_usd: 0 } }))).toEqual(['monthly']);
    expect(Object.keys(toUsageWindows({ included: pool(60, 30), purchased: { balance_usd: -1 } }))).toEqual(['monthly']);
    expect(Object.keys(toUsageWindows({ included: pool(60, 30) }))).toEqual(['monthly']);
  });

  it('answers no windows for a pool it cannot read, instead of guessing', () => {
    expect(toUsageWindows({})).toEqual({});
    expect(toUsageWindows({ included: {} })).toEqual({});
    expect(toUsageWindows({ included: { balance_usd: 10 } })).toEqual({});
    expect(toUsageWindows({ included: pool(0, 0) })).toEqual({});
    expect(toUsageWindows({ included: pool('sixty', 10) })).toEqual({});
    expect(toUsageWindows({ included: { allowance_usd: 60 } })).toEqual({});
    expect(toUsageWindows({ included: [pool(60, 10)] })).toEqual({});
  });

  it('rejects a body that is not a balance response rather than reading it as no usage', async () => {
    for (const body of [null, 'nope', {}, { included: {} }, { included: pool(0, 0) }]) {
      await expect(fetchOllamaCloudUsage('key', async () => new Response(JSON.stringify(body))))
        .rejects.toThrow('could not be parsed');
    }
  });
});
