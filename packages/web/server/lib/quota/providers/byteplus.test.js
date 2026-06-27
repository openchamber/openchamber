import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as byteplus from './byteplus.js';

/**
 * Sanitized canonical BytePlus GetCodingPlanUsage response shape.
 *
 * Mirrors the envelope returned by
 *   POST https://console.byteplus.com/api/top/ark/ap-southeast-1/2024-01-01/GetCodingPlanUsage
 *
 * - ResponseMetadata.RequestId / Action
 * - Result.Status (e.g. "Running")
 * - Result.UpdateTimestamp (unix seconds)
 * - Result.QuotaUsage[]: { Level, Percent (0-100 USED), ResetTimestamp (unix seconds) }
 *
 * ResetTimestamp values below are arbitrary fixed unix seconds; the provider
 * converts them to ms via toTimestamp (which auto-detects seconds vs ms).
 */
const CANONICAL_FIXTURE = {
  ResponseMetadata: {
    RequestId: 'req-00000000-0000-0000-0000-000000000000',
    Action: 'GetCodingPlanUsage',
  },
  Result: {
    Status: 'Running',
    UpdateTimestamp: 1719500000,
    QuotaUsage: [
      { Level: 'monthly', Percent: 42, ResetTimestamp: 1722470400 },
      { Level: 'session', Percent: 7, ResetTimestamp: 1719501800 },
      { Level: 'weekly', Percent: 23, ResetTimestamp: 1720104800 },
    ],
  },
};

describe('byteplus quota provider', () => {
  let getCredentialSpy;

  beforeEach(() => {
    getCredentialSpy = vi.spyOn(store, 'getCredential');
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValue({
      ok: true,
      json: async () => CANONICAL_FIXTURE,
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    getCredentialSpy.mockReturnValue(undefined);
    expect(byteplus.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when cookie contains csrfToken', () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; other=def' },
    });
    expect(byteplus.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when cookie lacks csrfToken', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'foo=bar' } });
    expect(byteplus.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await byteplus.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when cookie lacks csrfToken', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'foo=bar' } });
    const result = await byteplus.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical QuotaUsage into ordered usage windows', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });
    const result = await byteplus.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    const windows = result.usage.windows;
    // Canonical sort order: session, weekly, monthly.
    const keys = Object.keys(windows);
    expect(keys).toEqual(['Session', 'Weekly', 'Monthly']);

    // Session: Percent=7 (used), ResetTimestamp=1719501800 (unix seconds).
    expect(windows.Session.usedPercent).toBe(7);
    expect(windows.Session.remainingPercent).toBe(93);
    // toTimestamp auto-converts seconds -> ms.
    expect(windows.Session.resetAt).toBe(1719501800 * 1000);

    // Weekly: Percent=23.
    expect(windows.Weekly.usedPercent).toBe(23);
    expect(windows.Weekly.remainingPercent).toBe(77);
    expect(windows.Weekly.resetAt).toBe(1720104800 * 1000);

    // Monthly: Percent=42.
    expect(windows.Monthly.usedPercent).toBe(42);
    expect(windows.Monthly.remainingPercent).toBe(58);
    expect(windows.Monthly.resetAt).toBe(1722470400 * 1000);
  });

  it('uses canonical POST endpoint, headers (X-Csrf-Token from cookie), and empty body', async () => {
    const fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
    fetchSpy.mockClear();
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=ABC123; session=XYZ' },
    });
    await byteplus.fetchQuota();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];

    // Canonical endpoint, verbatim.
    expect(url).toBe(
      'https://console.byteplus.com/api/top/ark/ap-southeast-1/2024-01-01/GetCodingPlanUsage',
    );
    expect(opts.method).toBe('POST');
    // Body is the canonical empty JSON object.
    expect(opts.body).toBe('{}');
    // Headers include Cookie, X-Csrf-Token (extracted from cookie), Content-Type.
    expect(opts.headers.Cookie).toBe('csrfToken=ABC123; session=XYZ');
    expect(opts.headers['X-Csrf-Token']).toBe('ABC123');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('returns configured:false (no cache fallback) when csrfToken cannot be extracted', async () => {
    // Schema would reject this upstream, but the provider must also defend.
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'noTokenHere=1' } });
    const result = await byteplus.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
  });

  it('returns ok:false with no cache fallback on 401/403', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const result = await byteplus.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient retryable failure', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });

    // First call: success -> populates cache.
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValueOnce({
      ok: true,
      json: async () => CANONICAL_FIXTURE,
    });
    const first = await byteplus.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: retryable failure (throws) -> stale fallback.
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockRejectedValueOnce(
      new Error('Request failed with status 502'),
    );
    const second = await byteplus.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
    // Stale result preserves the canonical windows.
    expect(Object.keys(second.usage.windows)).toEqual([
      'Session',
      'Weekly',
      'Monthly',
    ]);
  });

  it('returns ok:false when Result.QuotaUsage is empty', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValue({
      ok: true,
      json: async () => ({
        ResponseMetadata: { RequestId: 'r', Action: 'GetCodingPlanUsage' },
        Result: { Status: 'Running', UpdateTimestamp: 1, QuotaUsage: [] },
      }),
    });
    const result = await byteplus.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
  });

  it('returns ok:false on ResponseMetadata.Error envelope', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValue({
      ok: true,
      json: async () => ({
        ResponseMetadata: {
          RequestId: 'r',
          Action: 'GetCodingPlanUsage',
          Error: { Code: 'AuthFail', Message: 'invalid csrf' },
        },
        Result: null,
      }),
    });
    const result = await byteplus.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
  });

  it('skips malformed QuotaUsage entries but keeps valid ones', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: 'csrfToken=abc; session=def' },
    });
    vi.spyOn(fetchUtils, 'fetchWithRetry').mockResolvedValue({
      ok: true,
      json: async () => ({
        ResponseMetadata: { RequestId: 'r', Action: 'GetCodingPlanUsage' },
        Result: {
          Status: 'Running',
          UpdateTimestamp: 1,
          QuotaUsage: [
            { Level: 'session', Percent: 10, ResetTimestamp: 1719501800 },
            { Level: 123, Percent: 50, ResetTimestamp: 2 }, // malformed Level
            { Level: 'weekly', Percent: 'not-a-number', ResetTimestamp: 3 }, // malformed Percent
            { Level: 'monthly', Percent: 5, ResetTimestamp: 'oops' }, // malformed ResetTimestamp
          ],
        },
      }),
    });
    const result = await byteplus.fetchQuota();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['Session']);
  });
});