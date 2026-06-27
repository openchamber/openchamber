import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import * as fetchUtils from '../utils/fetch.js';
import * as authModule from '../../opencode/auth.js';
import * as xai from './xai.js';

// Sanitized canonical response shapes (fake token values, realistic numeric
// fields). Mirrors the xAI / Grok billing contracts ported from
// mystatus/plugin/mystatus.ts (lines 2056-2162):
//
//   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//     -> { config: { creditUsagePercent, billingPeriodEnd, onDemandUsed, onDemandCap,
//                    productUsage: [{ product, usagePercent }], prepaidBalance } }
//   GET https://cli-chat-proxy.grok.com/v1/billing
//     -> { config: { monthlyLimit: { val }, used: { val }, billingPeriodEnd } }
//   GET https://api.x.ai/v1/models
//     -> 200 OK (reachability liveness check)
//
// Auth sources:
//   - ~/.grok/auth.json (consumer SuperGrok, OAuth auto-refresh):
//       { "<storeKey>": { key: "<access jwt>", refresh_token, expires_at } }
//   - OpenCode auth.json keys 'xai' / 'xai-oauth' (dev API):
//       { type: 'oauth', access: '<token>', expires: <epoch ms> }

const GROK_AUTH = {
  'xai::b1a00492-073a-47ea-816f-4c329264a828': {
    key: 'fake.consumer.access.jwt',
    refresh_token: 'fake.refresh.token',
    expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h in the future
  },
};

const GROK_AUTH_EXPIRED = {
  'xai::b1a00492-073a-47ea-816f-4c329264a828': {
    key: 'fake.consumer.stale.jwt',
    refresh_token: 'fake.refresh.token',
    expires_at: new Date(Date.now() - 60_000).toISOString(), // expired 1 min ago
  },
};

const XAI_OAUTH_AUTH = {
  xai: { type: 'oauth', access: 'fake.dev.access.token', expires: Date.now() + 3600_000 },
};

const REFRESH_TOKEN_RESPONSE = {
  access_token: 'fake.consumer.refreshed.jwt',
  refresh_token: 'fake.refresh.token.rotated',
  expires_in: 3600,
};

// creditUsagePercent=25 -> remaining 75, usedPercent 25.
const BILLING_CREDITS_RESPONSE = {
  config: {
    creditUsagePercent: 25,
    billingPeriodEnd: '2099-07-01T00:00:00.000Z',
    onDemandUsed: { val: 3 },
    onDemandCap: { val: 10 },
    productUsage: [
      { product: 'GrokBuild', usagePercent: 15 },
      { product: 'Api', usagePercent: 10 },
    ],
    prepaidBalance: { val: 50 },
  },
};

const BILLING_DEFAULT_RESPONSE = {
  config: {
    monthlyLimit: { val: 1000 },
    used: { val: 250 },
    billingPeriodEnd: '2099-07-01T00:00:00.000Z',
  },
};

const MODELS_RESPONSE_OK = { ok: true, json: async () => ({ data: [] }) };

describe('xai quota provider (OAuth — consumer ~/.grok/auth.json + dev auth.json)', () => {
  let fetchSpy;
  let loadAuthMergedSpy;
  let readGrokAuthSpy;
  let writeGrokAuthSpy;
  let readGrokAuthFileSyncSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
    loadAuthMergedSpy = vi.spyOn(authModule, 'loadAuthMerged');
    readGrokAuthSpy = vi.spyOn(authModule, 'readGrokAuth');
    // Spy on fs.writeFileSync to assert the OAuth refresh write-back is
    // invoked with the refreshed payload (and that no token values are
    // logged via console — we only assert the file content here).
    writeGrokAuthSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    // The refresh write-back path reads the file directly via fs.readFileSync
    // (not via readGrokAuth, which is mocked). Stub it so the write-back can
    // parse the fixture and proceed to the writeFileSync branch.
    readGrokAuthFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => '{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns true when ~/.grok/auth.json has a token', () => {
    readGrokAuthSpy.mockReturnValue(GROK_AUTH);
    loadAuthMergedSpy.mockReturnValue({});
    expect(xai.isConfigured()).toBe(true);
  });

  it('isConfigured returns true when auth.json has xai oauth', () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue(XAI_OAUTH_AUTH);
    expect(xai.isConfigured()).toBe(true);
  });

  it('isConfigured returns true when auth.json has xai-oauth alias', () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue({ 'xai-oauth': XAI_OAUTH_AUTH.xai });
    expect(xai.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when neither source has a token', () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue({});
    expect(xai.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when neither source is present', async () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue({});
    const result = await xai.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('transforms canonical billing?credits + billing + models into windows/footer (consumer token, no refresh)', async () => {
    readGrokAuthSpy.mockReturnValue(GROK_AUTH);
    loadAuthMergedSpy.mockReturnValue(XAI_OAUTH_AUTH);
    // billing?credits (GET), billing (GET), models (GET) in canonical order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_CREDITS_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_DEFAULT_RESPONSE })
      .mockResolvedValueOnce(MODELS_RESPONSE_OK);

    const result = await xai.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Three canonical endpoints called in order. No refresh fetch since the
    // consumer token is still valid.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const calls = fetchSpy.mock.calls;
    expect(calls[0][0]).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    expect(calls[1][0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(calls[2][0]).toBe('https://api.x.ai/v1/models');

    // Bearer token on every call is the consumer token (preferred over dev).
    for (const [, opts] of calls) {
      expect(opts.headers.Authorization).toBe('Bearer fake.consumer.access.jwt');
      expect(opts.headers.Accept).toBe('application/json');
    }
    // models call carries the canonical x-grok-source header.
    expect(calls[2][1].headers['x-grok-source']).toBe('opencode-allstatus');

    const windows = result.usage.windows;
    expect(Object.keys(windows).sort()).toEqual(['credits']);

    const creditsWindow = windows.credits;
    // creditUsagePercent=25 -> usedPercent 25, remaining 75.
    expect(creditsWindow.usedPercent).toBe(25);
    expect(creditsWindow.remainingPercent).toBe(75);
    expect(creditsWindow.resetAt).toBe('2099-07-01T00:00:00.000Z');
    expect(creditsWindow.valueLabel).toBe('SuperGrok credits');
    // detail carries: credits used %, product breakdown, on-demand, prepaid, used/limit.
    expect(Array.isArray(creditsWindow.detail)).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('Credits used: 25.00%'))).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('Build: 15.00%'))).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('SuperGrok: 10.00%'))).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('On-demand: 3/10'))).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('Prepaid balance: 50'))).toBe(true);
    expect(creditsWindow.detail.some((l) => l.includes('Used: 250 / 1,000 credits'))).toBe(true);

    // Footer surfaces auth status + SuperGrok hint absence (consumer present).
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Auth:'))).toBe(true);
    // No SuperGrok "run grok login" hint when consumer token is present.
    expect(result.usage.footer.some((l) => l.includes('grok login'))).toBe(false);
  });

  it('refreshes an expired consumer token before fetching, and persists the refreshed token back to ~/.grok/auth.json', async () => {
    readGrokAuthSpy.mockReturnValue(GROK_AUTH_EXPIRED);
    loadAuthMergedSpy.mockReturnValue(XAI_OAUTH_AUTH);
    // The refresh write-back reads ~/.grok/auth.json directly via fs.readFileSync
    // (bypassing the mocked readGrokAuth). Stub it to return the expired fixture
    // so the write-back can locate the storeKey entry and persist the refresh.
    readGrokAuthFileSyncSpy.mockReturnValue(JSON.stringify(GROK_AUTH_EXPIRED));
    // refresh (POST), billing?credits (GET), billing (GET), models (GET).
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => REFRESH_TOKEN_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_CREDITS_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_DEFAULT_RESPONSE })
      .mockResolvedValueOnce(MODELS_RESPONSE_OK);

    const result = await xai.fetchQuota();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const calls = fetchSpy.mock.calls;
    // First call is the OAuth refresh.
    expect(calls[0][0]).toBe('https://auth.x.ai/oauth2/token');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0][1].headers.Accept).toBe('application/json');
    // Body is URLSearchParams-encoded; grant_type=refresh_token, client_id, refresh_token.
    const body = String(calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=b1a00492-073a-47ea-816f-4c329264a828');
    expect(body).toContain('refresh_token=fake.refresh.token');

    // Subsequent calls use the refreshed consumer token.
    expect(calls[1][1].headers.Authorization).toBe('Bearer fake.consumer.refreshed.jwt');

    // Write-back happened with the refreshed payload (no token values logged).
    expect(writeGrokAuthSpy).toHaveBeenCalled();
    const written = String(writeGrokAuthSpy.mock.calls[0][1]);
    expect(written).toContain('fake.consumer.refreshed.jwt');
    expect(written).toContain('fake.refresh.token.rotated');
  });

  it('falls back to dev token when consumer auth is absent (Grok credits label, SuperGrok hint in footer)', async () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue(XAI_OAUTH_AUTH);
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_CREDITS_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_DEFAULT_RESPONSE })
      .mockResolvedValueOnce(MODELS_RESPONSE_OK);

    const result = await xai.fetchQuota();

    expect(result.ok).toBe(true);
    const calls = fetchSpy.mock.calls;
    // Bearer token is the dev token.
    expect(calls[0][1].headers.Authorization).toBe('Bearer fake.dev.access.token');
    // Window label reflects dev-only (no consumer).
    expect(result.usage.windows.credits.valueLabel).toBe('Grok credits');
    // Footer surfaces the canonical SuperGrok hint.
    expect(result.usage.footer.some((l) => l.includes('grok login'))).toBe(true);
  });

  it('returns ok:false when models reachability check fails (token invalid)', async () => {
    readGrokAuthSpy.mockReturnValue(GROK_AUTH);
    loadAuthMergedSpy.mockReturnValue({});
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_CREDITS_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => BILLING_DEFAULT_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await xai.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    // 401/403 surfaces an actionable re-auth hint, never a bare status code.
    expect(result.error).toMatch(/expired|revoked|grok login/i);
    // Error must NOT include any token value.
    expect(result.error).not.toContain('fake.consumer.access.jwt');
  });

  it('returns ok:false with token-expired hint when dev token expired and no consumer token', async () => {
    readGrokAuthSpy.mockReturnValue(null);
    loadAuthMergedSpy.mockReturnValue({
      xai: { type: 'oauth', access: 'fake.dev.access.token', expires: Date.now() - 1000 },
    });
    const result = await xai.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/expired/i);
  });
});