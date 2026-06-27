import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '../../opencode/auth.js';
import * as credentialsPath from '../utils/credentials-path.js';
import { fetchQuota, isConfigured } from './copilot.js';

// Canonical CopilotUsageData (mystatus.ts CopilotUsageData):
//   copilot_plan: string
//   quota_reset_date: string (ISO date)
//   quota_snapshots: {
//     premium_interactions: CopilotQuotaDetail,
//     chat?: CopilotQuotaDetail,
//     completions?: CopilotQuotaDetail,
//   }
//
// CopilotQuotaDetail:
//   entitlement: number
//   percent_remaining: number
//   remaining: number
//   unlimited: boolean
//   overage_count?: number
//
// Canonical PAT billing response (GET /users/{u}/settings/billing/premium_request/usage):
//   timePeriod: { year, month? }
//   user: string
//   usageItems: Array<{ sku, grossQuantity, model?, unitType }>
//
// Canonical COPILOT_PLAN_LIMITS: free=50, pro=300, pro+=1500, business=300, enterprise=1000.

const OAUTH_FIXTURE = {
  copilot_plan: 'pro',
  quota_reset_date: new Date(Date.now() + 5 * 86_400_000 + 3 * 3_600_000).toISOString(),
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      percent_remaining: 75,
      remaining: 225,
      unlimited: false,
      overage_count: 0
    },
    chat: {
      entitlement: 1000,
      percent_remaining: 90,
      remaining: 900,
      unlimited: false
    },
    completions: {
      entitlement: 1000,
      percent_remaining: 100,
      remaining: 1000,
      unlimited: false
    }
  }
};

const OAUTH_FIXTURE_UNLIMITED = {
  copilot_plan: 'pro',
  quota_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
  quota_snapshots: {
    premium_interactions: {
      entitlement: 0,
      percent_remaining: 100,
      remaining: 0,
      unlimited: true,
      overage_count: 0
    },
    chat: {
      entitlement: 0,
      percent_remaining: 100,
      remaining: 0,
      unlimited: true
    },
    completions: {
      entitlement: 0,
      percent_remaining: 100,
      remaining: 0,
      unlimited: true
    }
  }
};

const OAUTH_FIXTURE_OVERAGE = {
  copilot_plan: 'pro',
  quota_reset_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      percent_remaining: 0,
      remaining: 0,
      unlimited: false,
      overage_count: 42
    }
  }
};

const PAT_BILLING_FIXTURE = {
  timePeriod: { year: 2026, month: 6 },
  user: 'octocat',
  usageItems: [
    { sku: 'Copilot Premium Request', grossQuantity: 120, model: 'gpt-5', unitType: 'requests' },
    { sku: 'Copilot Premium Request', grossQuantity: 30, model: 'claude-sonnet', unitType: 'requests' },
    { sku: 'Copilot Completions', grossQuantity: 500, unitType: 'requests' }
  ]
};

describe('github-copilot quota provider', () => {
  let fetchSpy;
  let authSpy;
  let patPathSpy;
  let fsExistsSpy;
  let fsReadSpy;

  beforeEach(() => {
    authSpy = vi.spyOn(authModule, 'readAuthFile');
    patPathSpy = vi.spyOn(credentialsPath, 'getLegacyOpenCodePath');
    fsExistsSpy = vi.spyOn(fs, 'existsSync');
    fsReadSpy = vi.spyOn(fs, 'readFileSync');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- isConfigured ----

  it('isConfigured returns true when PAT file is present', () => {
    authSpy.mockReturnValue({});
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(true);
    fsReadSpy.mockReturnValue(
      JSON.stringify({ token: 'github_pat_fake', username: 'octocat', tier: 'pro' })
    );
    expect(isConfigured()).toBe(true);
  });

  it('isConfigured returns true when OAuth access token is present', () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-access' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    expect(isConfigured()).toBe(true);
  });

  it('isConfigured returns false when neither PAT nor OAuth token', () => {
    authSpy.mockReturnValue({});
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    expect(isConfigured()).toBe(false);
  });

  // ---- OAuth transform ----

  it('transforms canonical OAuth response into correct windows with resetText countdown', async () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-access' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => OAUTH_FIXTURE });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/copilot_internal/user');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('token fake-access');
    expect(opts.headers['Editor-Version']).toBe('vscode/1.107.0');
    expect(opts.headers['User-Agent']).toMatch(/GitHubCopilotChat\//);
    expect(opts.headers['Copilot-Integration-Id']).toBe('vscode-chat');
    // Canonical OAuth endpoint does NOT send X-GitHub-Api-Version.
    expect(opts.headers['X-GitHub-Api-Version']).toBeUndefined();

    const windows = result.usage.windows;
    // Canonical order: premium first; chat + completions included (not unlimited).
    expect(Object.keys(windows)).toEqual(['premium', 'chat', 'completions']);

    // percent_remaining=75 -> usedPercent=25, remainingPercent=75.
    const premium = windows.premium;
    expect(premium.usedPercent).toBe(25);
    expect(premium.remainingPercent).toBe(75);
    // detail uses canonical "Used: X / Y" format (used=entitlement-remaining=75).
    expect(premium.detail).toEqual(['Used: 75 / 300']);
    expect(premium.valueLabel).toBe('75 / 300');
    expect(premium.suffix).toBe('premium');
    expect(premium.trendKey).toBe('github-copilot:premium');
    // resetText is the canonical countdown string ("5d 3h" for ~5d3h away).
    expect(premium.resetText).toMatch(/^\d+d \d+h$/);
    // resetAt is an absolute timestamp derived from quota_reset_date.
    expect(premium.resetAt).toBeGreaterThan(Date.now());

    const chat = windows.chat;
    expect(chat.usedPercent).toBe(10);
    expect(chat.detail).toEqual(['Used: 100 / 1000']);

    const completions = windows.completions;
    expect(completions.usedPercent).toBe(0);
    expect(completions.detail).toEqual(['Used: 0 / 1000']);
  });

  it('skips chat/completions windows when unlimited (canonical conditional inclusion)', async () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-access' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => OAUTH_FIXTURE_UNLIMITED });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    const windows = result.usage.windows;
    // Only premium is included; chat + completions are unlimited -> skipped.
    expect(Object.keys(windows)).toEqual(['premium']);
    const premium = windows.premium;
    expect(premium.usedPercent).toBe(0);
    expect(premium.detail).toEqual(['Used: Unlimited']);
  });

  it('attaches overage_count as extra on every window when > 0', async () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-access' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => OAUTH_FIXTURE_OVERAGE });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    const premium = result.usage.windows.premium;
    expect(premium.usedPercent).toBe(100);
    expect(premium.extra).toEqual(['Overage: 42 requests']);
  });

  it('returns configured:false when no PAT and no OAuth token', async () => {
    authSpy.mockReturnValue({});
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---- PAT path ----

  it('transforms canonical PAT billing response into a premium window with billing period', async () => {
    authSpy.mockReturnValue({});
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(true);
    fsReadSpy.mockReturnValue(
      JSON.stringify({ token: 'github_pat_fake', username: 'octocat', tier: 'pro' })
    );
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => PAT_BILLING_FIXTURE });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    // Canonical PAT endpoint: GET /users/{u}/settings/billing/premium_request/usage
    expect(url).toBe('https://api.github.com/users/octocat/settings/billing/premium_request/usage');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer github_pat_fake');
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
    expect(opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');

    const windows = result.usage.windows;
    expect(Object.keys(windows)).toEqual(['premium']);
    const premium = windows.premium;
    // totalUsed = 120 + 30 = 150 (Premium SKUs only); limit=300 (pro tier).
    // remaining = 150; pct = 50; usedPercent = 50.
    expect(premium.usedPercent).toBe(50);
    expect(premium.remainingPercent).toBe(50);
    expect(premium.valueLabel).toBe('150 / 300');
    expect(premium.detail).toEqual(['Used: 150 / 300']);
    // Billing period YYYY-MM.
    expect(premium.extra).toEqual(['Billing period: 2026-06']);
    expect(premium.suffix).toBe('premium');
    expect(premium.trendKey).toBe('github-copilot:premium');
  });

  it('PAT takes precedence over OAuth (canonical queryCopilot checks PAT first)', async () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-oauth' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(true);
    fsReadSpy.mockReturnValue(
      JSON.stringify({ token: 'github_pat_fake', username: 'octocat', tier: 'pro' })
    );
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => PAT_BILLING_FIXTURE });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    // PAT endpoint called, not OAuth.
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/users/octocat/settings/billing/premium_request/usage');
  });

  it('returns ok:false with PAT guidance when OAuth direct call fails and token exchange fails', async () => {
    authSpy.mockReturnValue({ 'github-copilot': { type: 'oauth', access: 'fake-access' } });
    patPathSpy.mockReturnValue('/fake/copilot-quota-token.json');
    fsExistsSpy.mockReturnValue(false);
    // direct call 401, token exchange 403.
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/quota unavailable via OAuth/i);
    expect(result.error).toMatch(/copilot-quota-token\.json/);
  });
});