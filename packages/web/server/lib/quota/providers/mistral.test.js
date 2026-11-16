import { describe, expect, it, vi } from 'vitest';

import { fetchMistralUsage } from './mistral-billing.js';
import { isConfigured } from './mistral.js';

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
