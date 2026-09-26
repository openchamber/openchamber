import { describe, expect, it } from 'bun:test';
import {
  parseOllamaSettingsHtml,
  fetchOllamaCloudUsage,
  parseOllamaUsageJson,
  fetchOllamaApiUsage,
  fetchQuota
} from './ollama-cloud.js';

const API_USAGE_URL = 'https://ollama.com/api/usage';
const SETTINGS_URL = 'https://ollama.com/settings';

describe('Ollama Cloud quota provider', () => {
  it('rejects redirects without forwarding credentials', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('', { status: 302 }))).rejects.toThrow('authentication failed');
  });

  it('rejects successful pages without usage data', async () => {
    await expect(fetchOllamaCloudUsage({ cookie: 'session=secret' }, async () => new Response('<html></html>'))).rejects.toThrow('could not be parsed');
  });

  it('parses session/weekly/premium windows', () => {
    const windows = parseOllamaSettingsHtml('<p>Session usage: 42%</p><p>Weekly usage: 7%</p><p>Premium 120 / 1000</p>');
    expect(windows.session.usedPercent).toBe(42);
    expect(windows.weekly.usedPercent).toBe(7);
    expect(windows.premium.usedPercent).toBe(12);
    expect(windows.premium.valueLabel).toBe('120 / 1000');
  });

  it('parses the cost-based monthly usage shape', () => {
    const html = '<span class="text-sm">Monthly usage</span>\n      <span class="text-sm "\n        >$4.39 of $60 used</span\n      >';
    const windows = parseOllamaSettingsHtml(html);
    expect(windows.monthly.usedPercent).toBeCloseTo(7.3, 1);
    expect(windows.monthly.valueLabel).toBe('$4.39 / $60');
    expect(windows.monthly.remainingPercent).toBeCloseTo(92.7, 1);
  });

  it('parses the extra-usage credits balance', () => {
    const html = '<div><span>Balance remaining</span><span>$12.50</span></div><button>Add $5</button>';
    const windows = parseOllamaSettingsHtml(html);
    expect(windows.credits_balance.usedPercent).toBeNull();
    expect(windows.credits_balance.valueLabel).toBe('$12.50');
  });

  it('omits the credits balance when it is zero', () => {
    const html = '<div><span>Balance remaining</span><span>$0.00</span></div>';
    expect(parseOllamaSettingsHtml(html).credits_balance).toBeUndefined();
  });

  it('ignores nearby dollar amounts that are not the balance', () => {
    expect(parseOllamaSettingsHtml('<p>Add $5 to your balance when it hits $0</p>').credits_balance).toBeUndefined();
  });
});

describe('Ollama Cloud usage API parser', () => {
  it('parses both usage fractions into percentages', () => {
    const windows = parseOllamaUsageJson({
      activity: { cost: 1.23, period: 'month', models: [{ name: 'gpt-oss:120b' }] },
      limits: {
        session: { usage: 0.42, models: [{ name: 'gpt-oss:120b' }] },
        weekly: { usage: 0.07, models: [{ name: 'gpt-oss:120b' }] }
      }
    });

    expect(windows.session.usedPercent).toBeCloseTo(42);
    expect(windows.session.remainingPercent).toBeCloseTo(58);
    expect(windows.session.windowSeconds).toBeNull();
    expect(windows.session.resetAt).toBeNull();
    expect(windows.weekly.usedPercent).toBeCloseTo(7);
  });

  it('keeps a raw fractional percent without rounding', () => {
    const windows = parseOllamaUsageJson({ limits: { session: { usage: 0.123456 } } });
    expect(windows.session.usedPercent).toBeCloseTo(12.3456, 6);
  });

  it('parses a session-only plan shape', () => {
    const windows = parseOllamaUsageJson({ limits: { session: { usage: 0.5 } } });
    expect(Object.keys(windows)).toEqual(['session']);
    expect(windows.session.usedPercent).toBeCloseTo(50);
  });

  it('parses a weekly-only plan shape', () => {
    const windows = parseOllamaUsageJson({ limits: { weekly: { usage: '0.25' } } });
    expect(Object.keys(windows)).toEqual(['weekly']);
    expect(windows.weekly.usedPercent).toBeCloseTo(25);
  });

  it.each([
    [0, 0],
    ['0', 0],
    [1, 100],
    ['1', 100],
    [1.5, 100],
    [12, 100],
    [-0.25, 0],
    ['0.25', 25]
  ])('maps usage %j to %d percent with clamping', (usage, expected) => {
    const windows = parseOllamaUsageJson({ limits: { session: { usage } } });
    expect(windows.session.usedPercent).toBeCloseTo(expected);
  });

  it.each([
    {},
    { limits: null },
    { limits: {} },
    { limits: { session: { usage: null } } },
    { limits: { session: {} } },
    { limits: { session: { usage: undefined } } },
    { limits: { session: { usage: true } } },
    { limits: { session: { usage: Number.NaN } } },
    { limits: { session: { usage: Infinity } } },
    { limits: { session: { usage: '' } } },
    { limits: { session: { usage: '  ' } } },
    { limits: { session: { usage: '0.5x' } } },
    { limits: { session: { usage: {} } } },
    { limits: { session: { usage: [] } } },
    { limits: { session: { models: [{ usage: 1 }] } } },
    { activity: { models: [{ usage: 1 }] } }
  ])('omits missing or non-finite usage %j instead of rendering zero', (payload) => {
    const windows = parseOllamaUsageJson(payload);
    expect(Object.keys(windows)).toEqual([]);
  });

  it('ignores activity totals and per-model breakdowns', () => {
    const windows = parseOllamaUsageJson({
      activity: { cost: 9.99, models: [{ usage: 1 }] },
      limits: {
        session: { models: [{ usage: 1 }] },
        weekly: { usage: 0.5, models: [{ usage: 1 }] }
      }
    });
    expect(Object.keys(windows)).toEqual(['weekly']);
    expect(windows.weekly.usedPercent).toBeCloseTo(50);
  });
});

describe('Ollama Cloud usage API fetcher', () => {
  it('requests the documented endpoint shape without cookies', async () => {
    let request;
    const windows = await fetchOllamaApiUsage('test-api-key', async (url, init) => {
      request = { url, init };
      return Response.json({ limits: { session: { usage: 0.5 } } });
    });

    expect(request.url).toBe(API_USAGE_URL);
    expect(request.init.method).toBe('GET');
    const headers = new Headers(request.init.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer test-api-key');
    expect(headers.get('User-Agent')).toBe('OpenChamber quota provider');
    expect(headers.get('Cookie')).toBeNull();
    expect(request.init.redirect).toBe('manual');
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(windows.session.usedPercent).toBeCloseTo(50);
  });

  it.each([302, 307, 401, 403])('rejects HTTP %d as an authentication failure', async (status) => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => new Response('', { status })))
      .rejects.toThrow('Ollama Cloud authentication failed');
  });

  it.each([429, 500])('reports HTTP %d with the usage API error', async (status) => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => new Response('', { status })))
      .rejects.toThrow(`Ollama Cloud usage API returned HTTP ${status}`);
  });

  it('reports invalid JSON as a parse failure', async () => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => new Response('{')))
      .rejects.toThrow('Ollama Cloud usage data could not be parsed');
  });

  it('reports an empty body as a parse failure', async () => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => new Response('')))
      .rejects.toThrow('Ollama Cloud usage data could not be parsed');
  });

  it.each([null, ['limits'], 'not-an-object'])('reports a non-object payload %j as a parse failure', async (payload) => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => Response.json(payload)))
      .rejects.toThrow('Ollama Cloud usage data could not be parsed');
  });

  it('reports an activity-only payload as a plan without usage limits', async () => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => Response.json({ activity: { cost: 1 } })))
      .rejects.toThrow('Ollama Cloud usage API returned no usage limits for this plan');
  });

  it('reports a plan the endpoint cannot describe as no usage limits, not a parse failure', async () => {
    await expect(fetchOllamaApiUsage('test-api-key', async () => Response.json({ limits: { session: { models: [] } } })))
      .rejects.toThrow('Ollama Cloud usage API returned no usage limits for this plan');
  });
});

describe('Ollama Cloud source selection', () => {
  const readAuthWithKey = () => ({ 'ollama-cloud': { key: 'test-api-key', type: 'api' } });
  const readCookie = () => ({ cookie: 'test-ollama-cookie' });
  const usagePayload = { limits: { session: { usage: 0.5 } } };

  const recordRequests = (handler) => {
    const urls = [];
    return {
      urls,
      fetchImpl: async (url, init) => {
        urls.push(url);
        return handler(url, init);
      }
    };
  };

  it('uses only the usage API when both an API key and a cookie exist', async () => {
    const requests = recordRequests(() => Response.json(usagePayload));
    const result = await fetchQuota({
      readAuth: readAuthWithKey,
      readCredential: readCookie,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([API_USAGE_URL]);
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.session.usedPercent).toBeCloseTo(50);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-api-key');
    expect(serialized).not.toContain('test-ollama-cookie');
  });

  it.each([
    { 'ollama-cloud': { key: 'test-api-key' } },
    { 'ollama-cloud': { token: 'test-api-key' } },
    { 'ollama-cloud': 'test-api-key' },
    { ollamacloud: { key: 'test-api-key' } },
    { 'ollama-cloud': { key: '  ', token: 'test-api-key' } },
    { 'ollama-cloud': { key: 42, token: 'test-api-key' } }
  ])('treats auth entry %j as the API key', async (auth) => {
    const requests = recordRequests(() => Response.json(usagePayload));
    const result = await fetchQuota({
      readAuth: () => auth,
      readCredential: () => { throw new Error('Cookie must not be read for the API path'); },
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([API_USAGE_URL]);
    expect(result.ok).toBe(true);
  });

  it('uses the cookie scrape only when no API key exists', async () => {
    const requests = recordRequests(() => new Response('Session usage 12% Weekly usage 34%'));
    const result = await fetchQuota({
      readAuth: () => ({}),
      readCredential: readCookie,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([SETTINGS_URL]);
    expect(result.ok).toBe(true);
    expect(result.usage.windows.session.usedPercent).toBe(12);
    expect(result.usage.windows.weekly.usedPercent).toBe(34);
  });

  it('does not request anything when neither source is configured', async () => {
    const requests = recordRequests(() => Response.json(usagePayload));
    const result = await fetchQuota({
      readAuth: () => ({}),
      readCredential: () => null,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('does not fall back to the cookie when the API request fails', async () => {
    const requests = recordRequests(() => new Response('', { status: 500 }));
    const result = await fetchQuota({
      readAuth: readAuthWithKey,
      readCredential: readCookie,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([API_USAGE_URL]);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Ollama Cloud usage API returned HTTP 500');
  });

  it('treats an unreadable auth file as no API key and falls back to the cookie', async () => {
    const requests = recordRequests(() => new Response('Session usage 12%'));
    const result = await fetchQuota({
      readAuth: () => { throw new Error('Failed to read OpenCode auth configuration'); },
      readCredential: readCookie,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([SETTINGS_URL]);
    expect(result.ok).toBe(true);
  });

  it('reports not configured instead of crashing when the auth file is unreadable and no cookie exists', async () => {
    const requests = recordRequests(() => Response.json(usagePayload));
    const result = await fetchQuota({
      readAuth: () => { throw new Error('Failed to read OpenCode auth configuration'); },
      readCredential: () => null,
      fetchImpl: requests.fetchImpl
    });

    expect(requests.urls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });
});
