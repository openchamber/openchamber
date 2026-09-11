import { describe, expect, it, vi } from 'vitest';

import {
  extractFireworksAccountId,
  fetchQuota,
  isConfigured,
  parseFireworksAccountsResponse,
  parseFireworksMonthlySpendQuota
} from './fireworks.js';

const account = (id = 'my-account-id') => ({ name: `accounts/${id}` });
const quota = (overrides = {}) => ({
  name: 'accounts/my-account-id/quotas/monthly-spend-usd',
  value: '50',
  maxValue: '500',
  usage: 18.42,
  ...overrides
});
const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body
});

describe('Fireworks AI quota provider', () => {
  it('extracts an account ID from a valid resource name', () => {
    expect(extractFireworksAccountId('accounts/my-account-id')).toBe('my-account-id');
    expect(extractFireworksAccountId('projects/not-an-account')).toBeNull();
  });

  it('parses a valid accounts response', () => {
    expect(parseFireworksAccountsResponse({ accounts: [account()], totalSize: 1 })).toBe('my-account-id');
  });

  it.each([
    null,
    [],
    {},
    { accounts: null },
    { accounts: [{}] },
    { accounts: [account()], totalSize: '1' },
    { accounts: [account()], nextPageToken: 1 },
  ])('rejects malformed accounts response %#', (payload) => {
    expect(() => parseFireworksAccountsResponse(payload))
      .toThrow('Invalid accounts response from Fireworks AI');
  });

  it('parses monthly spend using value instead of maxValue', () => {
    const parsed = parseFireworksMonthlySpendQuota(quota(), 'my-account-id');

    expect(parsed.usedPercent).toBeCloseTo(36.84, 5);
    expect(parsed.remaining).toBeCloseTo(31.58, 5);
    expect(parsed.valueLabel).toBe('$31.58 left · $18.42 spent');
  });

  it('formats a usage-only monthly spend response', () => {
    const parsed = parseFireworksMonthlySpendQuota(quota({ value: null }), 'my-account-id');

    expect(parsed.usedPercent).toBeNull();
    expect(parsed.remaining).toBeNull();
    expect(parsed.valueLabel).toBe('$18.42 spent');
  });

  it('clamps spend percentages above 100 and remaining spend below zero', () => {
    const parsed = parseFireworksMonthlySpendQuota(quota({ value: '10', maxValue: '1000', usage: 12.5 }), 'my-account-id');

    expect(parsed.usedPercent).toBe(100);
    expect(parsed.remaining).toBe(0);
    expect(parsed.valueLabel).toBe('$0.00 left · $12.50 spent');
  });

  it.each([
    null,
    [],
    {},
    { name: 'accounts/my-account-id/quotas/requests-per-minute', value: '50', usage: 1 },
    quota({ value: '' }),
    quota({ value: 'NaN' }),
    quota({ usage: null }),
    quota({ usage: -1 })
  ])('rejects malformed monthly spend payload %#', (payload) => {
    expect(() => parseFireworksMonthlySpendQuota(payload, 'my-account-id'))
      .toThrow('Invalid monthly spend quota response from Fireworks AI');
  });

  it('returns a clear error when no accounts are accessible', () => {
    expect(() => parseFireworksAccountsResponse({ accounts: [], totalSize: 0 }))
      .toThrow('No Fireworks AI accounts are accessible');
  });

  it('refuses to choose between multiple returned accounts', () => {
    expect(() => parseFireworksAccountsResponse({ accounts: [account('one'), account('two')], totalSize: 2 }))
      .toThrow('Multiple Fireworks AI accounts are accessible');
  });

  it.each([
    { accounts: [account()], nextPageToken: 'another-page' },
    { accounts: [account()], totalSize: 2 }
  ])('refuses to choose when pagination metadata indicates more accounts', (payload) => {
    expect(() => parseFireworksAccountsResponse(payload))
      .toThrow('Configure accountId or account_id');
  });

  it.each([
    ['fireworks-ai', 'key'],
    ['fireworks', 'token'],
    ['fireworks_ai', 'key']
  ])('recognizes %s credentials stored under %s', (alias, field) => {
    expect(isConfigured({ [alias]: { [field]: 'test-api-key' } })).toBe(true);
  });

  it('does not request Fireworks when credentials are missing', async () => {
    const fetchImpl = vi.fn();

    const result = await fetchQuota({ readAuth: () => ({}), fetchImpl });

    expect(result).toMatchObject({
      providerId: 'fireworks-ai',
      providerName: 'Fireworks AI',
      ok: false,
      configured: false,
      error: 'Not configured',
      usage: null
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('discovers one account and fetches its monthly spend quota', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ accounts: [account()], totalSize: 1 }))
      .mockResolvedValueOnce(jsonResponse(quota()));

    const result = await fetchQuota({
      readAuth: () => ({ fireworks: { token: 'test-api-key' } }),
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.fireworks.ai/v1/accounts?pageSize=200');
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.fireworks.ai/v1/accounts/my-account-id/quotas/monthly-spend-usd'
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer test-api-key');
    expect(fetchImpl.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.monthly).toMatchObject({
      usedPercent: 36.84,
      remainingPercent: 63.16,
      windowSeconds: null,
      resetAt: null,
      valueLabel: '$31.58 left · $18.42 spent'
    });
  });

  it.each([
    ['accountId', 'my-account-id'],
    ['account_id', 'my-account-id'],
  ])('uses an explicit %s without account discovery', async (field, accountId) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(quota()));

    const result = await fetchQuota({
      readAuth: () => ({ fireworks_ai: { key: 'test-api-key', [field]: accountId } }),
      fetchImpl
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('/accounts/my-account-id/quotas/monthly-spend-usd');
  });

  it.each([401, 403, 429, 500])('returns a safe provider error when Fireworks returns HTTP %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status }));

    const result = await fetchQuota({
      readAuth: () => ({
        'fireworks-ai': {
          key: 'secret-that-must-not-leak',
          accountId: 'my-account-id'
        }
      }),
      fetchImpl
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe(status === 401 || status === 403
      ? 'Session expired — please re-authenticate with Fireworks AI'
      : `API error: ${status}`);
    expect(result.usage).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret-that-must-not-leak');
  });

  it('returns a safe provider error when the request fails', async () => {
    const result = await fetchQuota({
      readAuth: () => ({
        'fireworks-ai': {
          key: 'secret-that-must-not-leak',
          accountId: 'my-account-id'
        }
      }),
      fetchImpl: async () => {
        throw new Error('Network unavailable');
      }
    });

    expect(result).toMatchObject({
      ok: false,
      configured: true,
      error: 'Request failed',
      usage: null
    });
    expect(JSON.stringify(result)).not.toContain('secret-that-must-not-leak');
  });
});
