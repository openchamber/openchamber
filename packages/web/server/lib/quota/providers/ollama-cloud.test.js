import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as ollamaCloud from './ollama-cloud.js';

// Sanitized canonical SSR HTML matching the canonical scrapers ported
// verbatim from mystatus/plugin/mystatus.ts:
//   parseOllamaSettingsHtml: presence "Cloud usage", email regex, plan regex,
//     extraBalanceUsd regex, then per-kind parseOllamaUsageBlock.
//   parseOllamaUsageBlock(kind): aria-label="${kind} usage X% used",
//     data-time="..." reset, data-model="..." data-requests="N" rows.
//   parseOllamaBillingRenewal: "subscription renews on <span>...</span>".
//
// Session used 40% -> remaining 60%. Weekly used 12.5% -> remaining 87.5%.
// The Weekly block is the sliceEnd boundary for the Session block.

const COOKIE = '__Secure-session=fake-session-token; other=fake';

const SETTINGS_HTML = [
  '<!doctype html><html><body>',
  '<div class="text-sm text-neutral-500 break-words">jane@example.com</div>',
  '<span>Cloud usage</span><span class="ml-2">Pro</span>',
  '<div>Balance remaining</div><div class="font-mono">$4.20</div>',
  // Session usage block (canonical anchor + slice up to "Weekly usage").
  '<section aria-label="Session usage 40% used">',
  '  <time data-time="2026-07-01T00:00:00Z"></time>',
  '  <ul>',
  '    <li data-model="llama3:70b" data-requests="120"></li>',
  '    <li data-model="qwen2.5:32b" data-requests="30"></li>',
  '  </ul>',
  '</section>',
  // Weekly usage block (canonical anchor; sliceEnd for Session).
  '<section aria-label="Weekly usage 12.5% used">',
  '  <time data-time="2026-07-07T00:00:00Z"></time>',
  '  <ul>',
  '    <li data-model="llama3:70b" data-requests="800"></li>',
  '    <li data-model="qwen2.5:32b" data-requests="200"></li>',
  '  </ul>',
  '</section>',
  '</body></html>',
].join('\n');

const BILLING_HTML = [
  '<!doctype html><html><body>',
  '<p>Your subscription renews on <span class="date">2026-08-01</span>.</p>',
  '</body></html>',
].join('\n');

describe('ollama-cloud quota provider', () => {
  let getCredentialSpy;
  let fetchSpy;

  beforeEach(() => {
    getCredentialSpy = vi.spyOn(store, 'getCredential');
    fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    getCredentialSpy.mockReturnValue(undefined);
    expect(ollamaCloud.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when cookie contains __Secure-session=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    expect(ollamaCloud.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when cookie lacks __Secure-session=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    expect(ollamaCloud.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await ollamaCloud.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when cookie lacks __Secure-session=', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    const result = await ollamaCloud.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical settings + billing SSR HTML into correct windows/footer', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    // settings (GET), billing (GET) in canonical call order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => SETTINGS_HTML })
      .mockResolvedValueOnce({ ok: true, text: async () => BILLING_HTML });

    const result = await ollamaCloud.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Two canonical endpoints called in order.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls;
    expect(calls[0][0]).toBe('https://ollama.com/settings');
    expect(calls[0][1].method).toBeUndefined(); // GET
    expect(calls[1][0]).toBe('https://ollama.com/settings/billing');
    expect(calls[1][1].method).toBeUndefined(); // GET

    // Canonical headers on every call.
    for (const [, opts] of calls) {
      expect(opts.headers.Cookie).toBe(COOKIE);
      expect(opts.headers.Accept).toBe('text/html');
      expect(opts.headers['User-Agent']).toBe(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
      );
    }

    const windows = result.usage.windows;
    // Session + Weekly windows, keyed by lowercase label.
    expect(Object.keys(windows).sort()).toEqual(['session', 'weekly']);

    const session = windows.session;
    // Canonical: remaining = round(100 - usedPct). Session used 40 -> remaining 60.
    expect(session.usedPercent).toBe(40);
    expect(session.remainingPercent).toBe(60);
    expect(session.resetAt).toBe('2026-07-01T00:00:00Z');
    // detail carries the canonical "Used: X%" line.
    expect(Array.isArray(session.detail)).toBe(true);
    expect(session.detail.some((l) => l.includes('Used: 40%'))).toBe(true);

    const weekly = windows.weekly;
    // Weekly used 12.5 -> remaining 87.5 (toUsageWindow does not round).
    expect(weekly.usedPercent).toBe(12.5);
    expect(weekly.remainingPercent).toBe(87.5);
    expect(weekly.resetAt).toBe('2026-07-07T00:00:00Z');
    expect(weekly.detail.some((l) => l.includes('Used: 12.5%'))).toBe(true);

    // Footer: account/plan header lines, renewal line, extra balance line,
    // and per-window model breakdowns (canonical footer layout).
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('jane@example.com'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Ollama Pro'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Subscription renews'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Extra usage balance'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('llama3:70b'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('120 requests'))).toBe(true);
  });

  it('returns ok:false (no stale fallback) when settings page returns 401', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' });

    const result = await ollamaCloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('returns ok:false (no stale fallback) when settings HTML lacks Cloud usage', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    fetchSpy.mockResolvedValueOnce({ ok: true, text: async () => '<html>nope</html>' });

    const result = await ollamaCloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => SETTINGS_HTML })
      .mockResolvedValueOnce({ ok: true, text: async () => BILLING_HTML });
    const first = await ollamaCloud.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: settings fetch throws (network/retry exhausted).
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await ollamaCloud.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('tolerates billing fetch failure (enrichment only) and still returns ok', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => SETTINGS_HTML })
      .mockRejectedValueOnce(new Error('Network request failed'));

    const result = await ollamaCloud.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    // Footer present but renewal line absent (billing failed).
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Subscription renews'))).toBe(false);
  });
});