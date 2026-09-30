import { describe, expect, it } from 'bun:test';
import { fetchOllamaCloudUsage, toUsageWindows } from './ollama-cloud.js';

const keyed = (apiKey) => async (url, init) => {
  expect(url).toBe('https://ollama.com/api/usage');
  expect(init.method).toBe('GET');
  expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${apiKey}`);
  return new Response(JSON.stringify({ limits: { monthly: { usage: 0.25 } } }));
};

describe('Ollama Cloud quota provider', () => {
  it('authenticates with the API key OpenCode stores, never a cookie', async () => {
    const windows = await fetchOllamaCloudUsage('test-key', keyed('test-key'));
    expect(windows.monthly.usedPercent).toBe(25);
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

  it('rejects a successful response without usage data', async () => {
    await expect(fetchOllamaCloudUsage('key', async () => new Response(JSON.stringify({}))))
      .rejects.toThrow('could not be parsed');
    await expect(fetchOllamaCloudUsage('key', async () => new Response(JSON.stringify({ limits: {} }))))
      .rejects.toThrow('could not be parsed');
  });

  it('reports an unreadable body as such, not as a missing usage shape', async () => {
    // A body that cannot be read and a body that carries no usage are different
    // failures; merging them would hide a transport problem behind "no data".
    // The parser's wording differs per runner, so the failure is stubbed the
    // way the sibling suites do it and only the stub's own message is asserted.
    await expect(fetchOllamaCloudUsage('key', async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }))).rejects.toThrow('Unexpected token');
  });

  it('reads a fraction that arrives as a numeric string', () => {
    // The endpoint serialises the same 0..1 fraction as a number or as a
    // string; both are the same value and must render the same bar.
    expect(toUsageWindows({ limits: { monthly: { usage: '0.25' } } }).monthly.usedPercent).toBeCloseTo(25, 6);
    expect(toUsageWindows({ limits: { monthly: { usage: 0.25 } } }).monthly.usedPercent).toBeCloseTo(25, 6);
  });

  it('maps the current single-bucket shape', () => {
    const windows = toUsageWindows({ limits: { monthly: { usage: 0.4 } } });
    expect(windows.monthly.usedPercent).toBeCloseTo(40, 6);
    expect(windows.monthly.remainingPercent).toBeCloseTo(60, 6);
  });

  // The endpoint has served each of these at different times. All must render,
  // and the bars keep the names the API used, so a plan is never relabelled
  // into a window it does not have.
  for (const buckets of [
    { session: { usage: 0.02 }, weekly: { usage: 0.05 } },
    { monthly: { usage: 0.4 } },
    { daily: { usage: 0.1 }, weekly: { usage: 0.6 }, monthly: { usage: 0.9 } },
  ]) {
    it(`renders every bucket of the ${Object.keys(buckets).join('+')} response the endpoint serves`, () => {
      expect(Object.keys(toUsageWindows({ limits: buckets })).sort()).toEqual(Object.keys(buckets).sort());
    });
  }

  it('clamps a plan at or over its cap to 100', () => {
    expect(toUsageWindows({ limits: { monthly: { usage: 1 } } }).monthly.usedPercent).toBe(100);
    expect(toUsageWindows({ limits: { monthly: { usage: 1.4 } } }).monthly.usedPercent).toBe(100);
  });

  it('skips a bucket without a usable fraction instead of guessing', () => {
    // The endpoint is undocumented and has changed shape repeatedly, so an
    // unfamiliar bucket must cost only itself, never the whole tracker.
    const windows = toUsageWindows({ limits: { monthly: { usage: 0.25 }, tomorrow: { note: 'new' } } });
    expect(Object.keys(windows)).toEqual(['monthly']);
    expect(windows.monthly.usedPercent).toBeCloseTo(25, 6);
    expect(toUsageWindows({ limits: { monthly: { usage: 'half' } } })).toEqual({});
    expect(toUsageWindows({ limits: { monthly: { usage: null } } })).toEqual({});
  });

  it('answers no windows when the parsed payload carries no limits', () => {
    expect(toUsageWindows({})).toEqual({});
    expect(toUsageWindows({ limits: {} })).toEqual({});
    // `asObject` accepts an array, whose keys are indices: without the guard
    // this renders a window named `0`. The VS Code twin rejects it outright.
    expect(toUsageWindows({ limits: [{ usage: 0.5 }] })).toEqual({});
  });

  it('rejects a body that is not a usage response rather than reading it as no usage', async () => {
    for (const body of [null, 'nope', { limits: 'nope' }, { limits: [{ usage: 0.5 }] }]) {
      await expect(fetchOllamaCloudUsage('key', async () => new Response(JSON.stringify(body))))
        .rejects.toThrow('could not be parsed');
    }
  });
});
