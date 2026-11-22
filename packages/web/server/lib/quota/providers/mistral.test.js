import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMistralUsage } from './mistral-billing.js';
import { fetchQuota, fetchQuotaForCredential, isConfigured } from './mistral.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The payloads Mistral's Vibe CLI pins in tests/app_server/test_billing.py,
// taken from the dashboard's BudgetOUTJSON / SubscriptionOUTJSON.
const SUBSCRIPTION = { plan_name: 'INDIVIDUAL', payg_enabled: true, vibe_payg_enabled: true, enterprise: false };
const BUDGET = {
  vibe_budget: { usage_percentage: 42.5, initial_budget: 300.0, currency: 'EUR', reset_at: '2026-11-01T00:00:00Z', payg_enabled: false },
  api_budget: { usage_percentage: 3.0, initial_budget: 50.0, currency: 'EUR', reset_at: '2026-11-01T00:00:00Z' },
};

const billing = ({ budget = json(BUDGET), subscription = json(SUBSCRIPTION) } = {}) => vi.fn(async (url) => {
    if (url.endsWith('/billing/budget')) {
      if (budget instanceof Error) throw budget;
      return budget;
    }
    if (url.endsWith('/billing/subscription')) {
      if (subscription instanceof Error) throw subscription;
      return subscription;
    }
    throw new Error(`unexpected ${url}`);
});

const readUsage = (fetchMock) => fetchMistralUsage('test-key', fetchMock);
const readError = (fetchMock) => readUsage(fetchMock).then(() => null, (error) => error.message);

describe('Mistral usage reader', () => {
  it('reads the Vibe and API allowances with the plan name', async () => {
    const fetchMock = billing();

    const { windows, planLabel } = await readUsage(fetchMock);

    expect(planLabel).toBe('Pro');
    expect(windows.vibe).toMatchObject({
      usedPercent: 42.5,
      resetAt: Date.parse('2026-11-01T00:00:00Z'),
      valueLabel: '€127.50 / €300.00',
    });
    expect(windows.api).toMatchObject({ usedPercent: 3, valueLabel: '€1.50 / €50.00' });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url.startsWith('https://api.mistral.ai/v1/billing/')).toBe(true);
      expect(init.headers.Authorization).toBe('Bearer test-key');
      expect(init.redirect).toBe('error');
    }
  });

  it('marks pay-as-you-go on the Vibe allowance and keeps usage past 100%', async () => {
    const { windows } = await readUsage(billing({
      budget: json({ vibe_budget: { usage_percentage: 104, initial_budget: 100, currency: 'USD', reset_at: null } }),
    }));

    // The budget leaves payg out, so the subscription's vibe_payg_enabled decides.
    expect(windows.vibe).toMatchObject({ usedPercent: 104, resetAt: null, valueLabel: '$104.00 / $100.00 · PAYG' });
    expect(windows.api).toBeUndefined();
  });

  it('keeps the allowances when the plan read fails', async () => {
    const { windows, planLabel } = await readUsage(billing({ subscription: new Error('down') }));

    expect(planLabel).toBeNull();
    expect(Object.keys(windows)).toEqual(['vibe', 'api']);
  });

  it('keeps the budget when the plan read runs out of time', async () => {
    const aborted = { ok: true, status: 200, json: async () => { throw new DOMException('aborted', 'AbortError'); } };
    const fetchMock = billing({ subscription: aborted });

    const { windows } = await readUsage(fetchMock);

    expect(Object.keys(windows)).toEqual(['vibe', 'api']);
    // Each read has its own deadline, so the plan's cannot end the budget's.
    const [budgetSignal, planSignal] = fetchMock.mock.calls.map(([, init]) => init.signal);
    expect(budgetSignal).not.toBe(planSignal);
  });

  it('reports a plan without an allowance as a failed read, never as zero usage', async () => {
    const fetchMock = billing({ budget: json({ vibe_budget: null, api_budget: { usage_percentage: 0, initial_budget: 0, currency: 'EUR' } }) });

    expect(await readError(fetchMock)).toBe('This Mistral plan has no monthly allowance');
  });

  it.each([
    [401, 'Mistral rejected the API key'],
    [403, 'This Mistral API key has no permission to see the organization usage'],
    [404, 'Mistral does not report usage for this account'],
    [500, 'API error: 500'],
  ])('keeps the budget answer %s apart', async (status, error) => {
    expect(await readError(billing({ budget: json({}, status) }))).toBe(error);
  });

  it('reports a body that is not JSON as an invalid response', async () => {
    const fetchMock = billing({ budget: { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } } });

    expect(await readError(fetchMock)).toBe('Invalid response from provider');
  });

  it('counts a stored key under key or token as configured', () => {
    expect(isConfigured({ mistral: { key: 'k' } })).toBe(true);
    expect(isConfigured({ mistral: { token: 't' } })).toBe(true);
    expect(isConfigured({})).toBe(false);
  });
});

// Fork behavior on top of the billing read: injected credential reads,
// per-credential fetches, the token/access fallbacks, and the key-validity
// class for keys whose plan has no billing allowance (budget answers 404).
const readAuth = async () => ({ mistral: { key: 'test-token' } });
const readEmptyAuth = async () => ({});

// Documented payload shape from GET https://api.mistral.ai/v1/models
const MODELS = { object: 'list', data: [{ id: 'mistral-medium-latest', object: 'model' }] };

const routed = ({ budget = json(BUDGET), subscription = json(SUBSCRIPTION), models = json(MODELS) } = {}) => vi.fn(async (url) => {
  const pick = url.endsWith('/billing/budget') ? budget : url.endsWith('/billing/subscription') ? subscription : url.endsWith('/v1/models') ? models : null;
  if (!pick) throw new Error(`unexpected ${url}`);
  if (pick instanceof Error) throw pick;
  return pick;
});

describe('Mistral quota provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the billing allowances through an injected credential read', async () => {
    const fetchMock = routed();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result).toMatchObject({ ok: true, configured: true, providerId: 'mistral', planLabel: 'Pro' });
    expect(Object.keys(result.usage.windows)).toEqual(['vibe', 'api']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('falls back to the key-validity class when the plan has no billing read (404)', async () => {
    const fetchMock = routed({ budget: json({}, 404) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
    expect(result.usage.usageAvailability).toBe('console-only');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/v1/models'))).toBe(true);
  });

  it.each([401, 403])('classifies a %i from the key-validity read as an invalid or revoked key', async (status) => {
    vi.stubGlobal('fetch', routed({ budget: json({}, 404), models: json({}, status) }));

    const result = await fetchQuota({ readAuth });

    expect(result).toMatchObject({ ok: false, configured: true });
    expect(result.error).toContain('Invalid or revoked API key');
  });

  it('classifies a key-validity 200 without the documented data array as malformed', async () => {
    vi.stubGlobal('fetch', routed({ budget: json({}, 404), models: json({ object: 'list' }) }));

    expect((await fetchQuota({ readAuth })).error).toBe('No quota data in response');
  });

  it('keeps a billing rejection other than 404 as the answer, without the fallback', async () => {
    const fetchMock = routed({ budget: json({}, 401) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result).toMatchObject({ ok: false, configured: true, error: 'Mistral rejected the API key' });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/v1/models'))).toBe(false);
  });

  it('is not configured without an enrolled credential', async () => {
    const result = await fetchQuota({ readAuth: readEmptyAuth });

    expect(result).toMatchObject({ ok: false, configured: false, error: 'Not configured' });
  });

  it('fetches with the token when the key field is empty', async () => {
    const fetchMock = routed();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth: async () => ({ mistral: { key: '', token: 'real-token' } }) });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer real-token');
    expect(isConfigured({ mistral: { key: '', token: 'real-token' } })).toBe(true);
  });

  it('fetches one stored credential with its own access value when the key is whitespace-only', async () => {
    const fetchMock = routed();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuotaForCredential({ value: { key: '   ', access: 'real-access' } });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer real-access');
    expect(isConfigured({ mistral: { key: '   ', access: 'real-access' } })).toBe(true);
  });

  it('reports not configured from both entry points when every field is empty', async () => {
    const entry = { key: '', token: '  ', access: '' };
    expect((await fetchQuota({ readAuth: async () => ({ mistral: entry }) })).configured).toBe(false);
    expect((await fetchQuotaForCredential({ value: entry })).error).toBe('Not configured');
    expect(isConfigured({ mistral: entry })).toBe(false);
  });
});
