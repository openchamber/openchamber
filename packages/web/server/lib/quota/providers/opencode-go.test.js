import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as opencode_go from './opencode-go.js';

// Sanitized SSR HTML fragments matching the canonical scraper regexes
// (ported from mystatus/plugin/mystatus.ts). No real credentials or tokens.

// Go dashboard SSR fragment: rollingUsage with usagePercent=30, resetInSec=3600.
// Also includes weekly + monthly windows to exercise all 3 GO_SCRAPE_PATTERNS.
const GO_HTML = [
  '<script>window.__DATA__=function(){',
  'rollingUsage:$R[0]={usagePercent:30,resetInSec:3600,other:"x"};',
  'weeklyUsage:$R[1]={resetInSec:259200,usagePercent:45.5};',
  'monthlyUsage:$R[2]={usagePercent:60,resetInSec:1296000};',
  '}()</script>',
].join('');

// Zen billing SSR fragment: balance=1234*1e8 units, monthlyUsage=500*1e8,
// monthlyLimit=null, reloadAmount=1, reloadTrigger=1, card ending 4242.
// (ZEN_UNITS_PER_DOLLAR = 1e8, so balanceUsd=1234.00, monthlyUsd=500.00)
const BILLING_HTML = [
  '<script>',
  'balance:123400000000,monthlyUsage:50000000000,monthlyLimit:null,',
  'reloadAmount:1,reloadTrigger:1,',
  'paymentMethodType:"card",paymentMethodLast4:"4242"',
  '</script>',
].join('');

// Zen usage SSR fragment: per-model costs in canonical units (1e8 per dollar).
// claude cost:5000 -> $0.000050; glm-4.6 cost:50000000 -> $0.50.
const USAGE_HTML = [
  '<script>',
  'entries:[{model:"claude",cost:5000},{model:"glm-4.6",cost:50000000}]',
  '</script>',
].join('');

// Billing HTML with a positive monthlyLimit (100*1e8 -> $100) to exercise
// the "X% of $Y/mo" branch instead of "Monthly spend".
const BILLING_HTML_WITH_LIMIT = [
  '<script>',
  'balance:123400000000,monthlyUsage:50000000000,monthlyLimit:10000000000,',
  'reloadAmount:1,reloadTrigger:1,',
  'paymentMethodType:"link",paymentMethodLast4:""',
  '</script>',
].join('');

// Billing HTML with a payment record (pay_abc, amount 25000000 -> $0.25).
const BILLING_HTML_WITH_PAYMENT = [
  '<script>',
  'balance:123400000000,monthlyUsage:50000000000,monthlyLimit:null,',
  'reloadAmount:1,reloadTrigger:1,',
  'paymentMethodType:"card",paymentMethodLast4:"4242",',
  'payments:[{id:"pay_abc",amount:25000000,timeCreated:$R[0]=new Date("2025-01-01T00:00:00.000Z")}]',
  '</script>',
].join('');

function makeResponse(html) {
  return { ok: true, text: async () => html };
}

describe('opencode-go quota provider', () => {
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
    expect(opencode_go.isConfigured()).toBe(false);
  });

  it('isConfigured returns false when only workspaceId present (no authCookie)', () => {
    getCredentialSpy.mockReturnValue({ credential: { workspaceId: 'ws-1' } });
    expect(opencode_go.isConfigured()).toBe(false);
  });

  it('isConfigured returns false when only authCookie present (no workspaceId)', () => {
    getCredentialSpy.mockReturnValue({ credential: { authCookie: 'cookie-1' } });
    expect(opencode_go.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when workspaceId + authCookie present', () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    expect(opencode_go.isConfigured()).toBe(true);
  });

  it('isConfigured returns true for multi-account credential with valid accounts', () => {
    getCredentialSpy.mockReturnValue({
      credential: {
        accounts: [
          { workspaceId: 'ws-1', authCookie: 'cookie-1' },
          { workspaceId: 'ws-2', authCookie: 'cookie-2' },
        ],
      },
    });
    expect(opencode_go.isConfigured()).toBe(true);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await opencode_go.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('parses Go rolling window usedPercent from rollingUsage SSR', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    // go, billing, usage — billing/usage best-effort null on failure.
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(''))
      .mockResolvedValueOnce(makeResponse(''));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeTruthy();
    const windows = result.usage.windows;
    // rolling window: usagePercent=30 -> usedPercent 30, remaining 70.
    expect(windows.rolling).toBeTruthy();
    expect(windows.rolling.usedPercent).toBe(30);
    expect(windows.rolling.remainingPercent).toBe(70);
    // weekly + monthly also parsed.
    expect(windows.weekly).toBeTruthy();
    expect(windows.weekly.usedPercent).toBe(46); // Math.round(45.5)
    expect(windows.monthly.usedPercent).toBe(60);
    expect(result.usage.accounts).toBeUndefined();
  });

  it('parses Zen balance footer from billing SSR', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(''));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    const footer = result.usage.footer;
    expect(footer).toBeTruthy();
    // balance 1234*1e8 / 1e8 = $1234.00
    expect(footer.some((l) => l.includes('Zen balance:    $1234.00'))).toBe(true);
    // paymentMethodType card + last4 4242
    expect(footer.some((l) => l.includes('Payment:        Card') && l.includes('4242'))).toBe(true);
    // monthlyLimit null -> "Monthly spend:  $500.00"
    expect(footer.some((l) => l.includes('Monthly spend:  $500.00'))).toBe(true);
  });

  it('renders "X% of $Y/mo" when monthlyLimit is positive', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML_WITH_LIMIT))
      .mockResolvedValueOnce(makeResponse(''));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    const footer = result.usage.footer;
    // monthlyUsd=500, limitUsd=100 -> pct=round(500%) clamped 100, remain=0.
    // Actually 500/100*100 = 500 -> clamped to 100, remain=0.
    expect(footer.some((l) => /0% of \$100\/mo/.test(l))).toBe(true);
  });

  it('parses per-model footer line from usage SSR', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(USAGE_HTML));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    const footer = result.usage.footer;
    // total cost = 5000/1e8 + 50000000/1e8 = 0.00005 + 0.5 = 0.50005 -> $0.50
    expect(footer.some((l) => /Zen spend:\s+\$0\.50 across 2 models/.test(l))).toBe(true);
    // top model line: glm-4.6 (higher cost) with cost $0.5000 and 1 request.
    expect(
      footer.some((l) => /glm-4\.6\s+\$0\.5000\s*\(1\)/.test(l)),
    ).toBe(true);
  });

  it('parses Zen payments from billing SSR', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-1', authCookie: 'cookie-1' },
    });
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML_WITH_PAYMENT))
      .mockResolvedValueOnce(makeResponse(''));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    const footer = result.usage.footer;
    // amount 25000000 / 1e8 = $0.25
    expect(footer.some((l) => l.includes('Payments:       +$0.25'))).toBe(true);
  });

  it('exposes usage.accounts for a 2-account credential', async () => {
    getCredentialSpy.mockReturnValue({
      credential: {
        accounts: [
          { id: 'acc-1', name: 'Work', workspaceId: 'ws-1', authCookie: 'cookie-1' },
          { id: 'acc-2', name: 'Personal', workspaceId: 'ws-2', authCookie: 'cookie-2' },
        ],
      },
    });
    // Each account triggers 3 fetches (go, billing, usage). 6 total.
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(USAGE_HTML))
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(USAGE_HTML));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.accounts).toBeTruthy();
    expect(result.usage.accounts.length).toBe(2);
    // Top-level windows/footer come from the first account.
    expect(result.usage.windows.rolling).toBeTruthy();
    expect(result.usage.footer).toBeTruthy();
    // Each account carries its own label/subtitle.
    expect(result.usage.accounts[0].label).toBe('Work');
    expect(result.usage.accounts[1].label).toBe('Personal');
    expect(result.usage.accounts[0].accountKey).toBe('acc-1');
    expect(result.usage.accounts[1].accountKey).toBe('acc-2');
  });

  it('collapses duplicate workspace entries before building account cards', async () => {
    getCredentialSpy.mockReturnValue({
      credential: {
        accounts: [
          { id: 'acc-1', name: 'Work', workspaceId: 'ws-duplicate', authCookie: 'cookie-1' },
          { id: 'acc-2', name: 'Work duplicate', workspaceId: 'ws-duplicate', authCookie: 'cookie-1' },
        ],
      },
    });
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(USAGE_HTML));

    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.usage.subtitle).toBe('Work');
    expect(result.usage.accounts).toBeUndefined();
  });

  it('falls back to stale cache on transient fetch failure', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-stale', authCookie: 'cookie-1' },
    });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce(makeResponse(GO_HTML))
      .mockResolvedValueOnce(makeResponse(BILLING_HTML))
      .mockResolvedValueOnce(makeResponse(USAGE_HTML));
    const first = await opencode_go.fetchQuota();
    expect(first.ok).toBe(true);
    expect(first.isStale).toBeFalsy();

    // Second call: all fetches reject (transient). goRes propagates to
    // outer catch; billing/usage are swallowed by .catch(()=>null).
    // Should fall back to cached result.
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new Error('Network down'));
    const second = await opencode_go.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
    expect(second.usage).toBeTruthy();
  });

  it('returns ok:false (no stale fallback) when goRes throws and no cache', async () => {
    // Distinct workspaceId so the module-level cache key differs from
    // any prior test's cached entry.
    getCredentialSpy.mockReturnValue({
      credential: { workspaceId: 'ws-nocache', authCookie: 'cookie-1' },
    });
    fetchSpy.mockRejectedValue(new Error('Network down'));
    const result = await opencode_go.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeFalsy();
  });
});
