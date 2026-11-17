import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../../opencode/auth.js';
import { fetchQuota, isConfigured } from './wafer.js';

beforeEach(() => {
  configureOpenCodeCredentials({
    list: async () => [{ active: true, integrationID: 'wafer', value: { type: 'key', key: 'test-key' } }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureOpenCodeCredentials(null);
});

const stubPayload = (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
};

describe('Wafer quota provider', () => {
  it('reports no quota data only when every quota field is null', async () => {
    stubPayload({});
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
  });

  it('treats a single present field as quota data', async () => {
    stubPayload({ overage_request_count: 0 });
    const result = await fetchQuota();
    expect(result.ok).toBe(true);
  });

  it('does not clamp usedPercent at 100 when there is overage', async () => {
    stubPayload({
      remaining_included_requests: 0,
      included_request_limit: 100,
      overage_request_count: 5,
      current_period_used_percent: 130,
      plan_tier: 'Pro',
    });
    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(130);
    expect(result.usage.windows['5h'].valueLabel).toBe('Pro · 0 / 100 left · +5 overage');
  });

  it('clamps usedPercent to 100 when there is no overage', async () => {
    stubPayload({
      remaining_included_requests: 0,
      included_request_limit: 100,
      overage_request_count: 0,
      current_period_used_percent: 130,
    });
    const result = await fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(100);
  });

  it('clamps a negative usedPercent at 0 in both cases', async () => {
    stubPayload({ current_period_used_percent: -5, overage_request_count: 3 });
    const withOverage = await fetchQuota();
    expect(withOverage.usage.windows['5h'].usedPercent).toBe(0);

    stubPayload({ current_period_used_percent: -5 });
    const withoutOverage = await fetchQuota();
    expect(withoutOverage.usage.windows['5h'].usedPercent).toBe(0);
  });

  it('derives usedPercent from remaining/limit when the percent is absent', async () => {
    stubPayload({
      remaining_included_requests: 40,
      included_request_limit: 100,
    });
    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(60);
    expect(result.usage.windows['5h'].remainingPercent).toBe(40);
    expect(result.usage.windows['5h'].valueLabel).toBe('40 / 100 left');
  });

  it('clamps the derived usedPercent when remaining exceeds the limit', async () => {
    stubPayload({
      remaining_included_requests: 120,
      included_request_limit: 100,
    });
    const result = await fetchQuota();
    expect(result.usage.windows['5h'].usedPercent).toBe(0);
  });

  it('reports a null usedPercent when the percent is absent and no counts can derive it', async () => {
    stubPayload({ overage_request_count: 5 });
    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBeNull();
    expect(result.usage.windows['5h'].remainingPercent).toBeNull();
  });

  it('builds the value label from remaining and limit without tier or overage', async () => {
    stubPayload({
      remaining_included_requests: 40,
      included_request_limit: 100,
      current_period_used_percent: 60,
    });
    const result = await fetchQuota();
    expect(result.usage.windows['5h'].valueLabel).toBe('40 / 100 left');
  });

  it('derives window seconds and label from window start/end', async () => {
    stubPayload({
      current_period_used_percent: 10,
      window_start: 1_700_000_000,
      window_end: 1_700_000_000 + 604_800,
    });
    const result = await fetchQuota();
    expect(result.usage.windows.weekly.windowSeconds).toBe(604800);
    expect(result.usage.windows.weekly.resetAt).toBe(1_700_604_800_000);
  });

  it('falls back to a fixed 5h window when start/end are absent', async () => {
    stubPayload({ current_period_used_percent: 10 });
    const result = await fetchQuota();
    expect(result.usage.windows['5h'].windowSeconds).toBe(18000);
  });

  it('reports an HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 503');
  });

  it('reports a JSON parse failure as an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });

  it('reports a generic fetch failure with its message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hangup')));
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('socket hangup');
  });

  it('reports a timeout when its own 15s signal aborts the request', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })));
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
  }, 25_000);
});

describe('Wafer credential selection (#1755)', () => {
  it('falls through an empty or whitespace key to the token in isConfigured', () => {
    expect(isConfigured({ wafer: { key: '', token: 'valid-token' } })).toBe(true);
    expect(isConfigured({ wafer: { key: '   ', token: 'valid-token' } })).toBe(true);
    expect(isConfigured({ wafer: { key: 'real-key', token: 'valid-token' } })).toBe(true);
  });

  it('reports not configured in isConfigured when both fields are empty or whitespace', () => {
    expect(isConfigured({ wafer: { key: ' ', token: '' } })).toBe(false);
    expect(isConfigured({ wafer: { key: '', token: '  ' } })).toBe(false);
  });

  it('does not send a whitespace key as a bearer in fetchQuota', async () => {
    configureOpenCodeCredentials({
      list: async () => [{ active: true, integrationID: 'wafer', value: { type: 'key', key: '   ' } }],
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat an empty key as configured in fetchQuota', async () => {
    configureOpenCodeCredentials({
      list: async () => [{ active: true, integrationID: 'wafer', value: { type: 'key', key: '' } }],
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
