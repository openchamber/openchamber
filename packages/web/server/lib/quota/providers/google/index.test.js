import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as authModule from './auth.js';
import * as apiModule from './api.js';
import { transformAntigravityBuckets, transformQuotaBucket } from './transforms.js';
import { fetchGoogleQuota } from './index.js';

// Fixture: retrieveUserQuota response with buckets spanning all 4 antigravity
// families (gemini-pro, gemini-flash, claude, gpt-oss) plus a chat_* helper
// model that must be dropped. Two gemini-pro buckets exercise the min-fraction
// / earliest-reset aggregation.
const QUOTA_BUCKETS_FIXTURE = [
  { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: '2026-06-27T20:00:00Z' },
  { modelId: 'gemini-2.5-pro-preview', remainingFraction: 0.6, resetTime: '2026-06-27T18:00:00Z' },
  { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-06-27T22:00:00Z' },
  { modelId: 'claude-sonnet-4', remainingFraction: 0.5, resetTime: '2026-06-27T23:00:00Z' },
  { modelId: 'gpt-oss-120b', remainingFraction: 0.7, resetTime: '2026-06-27T21:00:00Z' },
  { modelId: 'chat_helper_model', remainingFraction: 0.1, resetTime: '2026-06-27T12:00:00Z' }
];

describe('google antigravity transformAntigravityBuckets', () => {
  it('aggregates buckets into 4 family windows with min remaining and earliest reset', () => {
    const windows = transformAntigravityBuckets(QUOTA_BUCKETS_FIXTURE);

    expect(Object.keys(windows).sort()).toEqual(
      ['Claude', 'GPT-OSS', 'Gemini Flash', 'Gemini Pro']
    );

    // gemini-pro: min(0.8, 0.6) = 0.6 -> 60% remaining, 40% used
    expect(windows['Gemini Pro'].remainingPercent).toBe(60);
    expect(windows['Gemini Pro'].usedPercent).toBe(40);
    // earliest reset among the two pro buckets: 18:00 < 20:00
    expect(windows['Gemini Pro'].resetAt).toBe(Date.parse('2026-06-27T18:00:00Z'));

    // gemini-flash: 0.9 -> 90% remaining
    expect(windows['Gemini Flash'].remainingPercent).toBe(90);
    expect(windows['Gemini Flash'].usedPercent).toBe(10);

    // claude: 0.5 -> 50%
    expect(windows.Claude.remainingPercent).toBe(50);
    expect(windows.Claude.usedPercent).toBe(50);

    // gpt-oss: 0.7 -> 70%
    expect(windows['GPT-OSS'].remainingPercent).toBe(70);
    expect(windows['GPT-OSS'].usedPercent).toBe(30);
  });

  it('drops chat_*/tab_* helper models', () => {
    const windows = transformAntigravityBuckets([
      { modelId: 'chat_helper', remainingFraction: 0.1, resetTime: null },
      { modelId: 'tab_something', remainingFraction: 0.2, resetTime: null }
    ]);
    expect(Object.keys(windows)).toEqual([]);
  });

  it('returns empty windows for empty/null buckets', () => {
    expect(transformAntigravityBuckets([])).toEqual({});
    expect(transformAntigravityBuckets(null)).toEqual({});
    expect(transformAntigravityBuckets(undefined)).toEqual({});
  });

  it('emits Antigravity suffix and stable trendKey per family', () => {
    const windows = transformAntigravityBuckets([
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime: '2026-06-27T20:00:00Z' }
    ]);
    expect(windows['Gemini Pro'].suffix).toBe('Antigravity');
    expect(windows['Gemini Pro'].trendKey).toBe('google:antigravity:Gemini Pro');
  });
});

describe('google transformQuotaBucket (gemini source)', () => {
  it('scopes modelId under sourceId and emits daily window', () => {
    const result = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.75, resetTime: '2026-06-27T20:00:00Z' },
      'gemini'
    );
    expect(result).toBeTruthy();
    expect(result['gemini/gemini-2.5-pro']).toBeTruthy();
    const win = result['gemini/gemini-2.5-pro'].windows.daily;
    expect(win.remainingPercent).toBe(75);
    expect(win.usedPercent).toBe(25);
    expect(win.suffix).toBe('Gemini');
  });
});

describe('google fetchGoogleQuota multi-account', () => {
  let authSpy;
  let refreshSpy;
  let quotaSpy;
  let modelsSpy;

  beforeEach(() => {
    authSpy = vi.spyOn(authModule, 'resolveGoogleAuthSources');
    refreshSpy = vi.spyOn(apiModule, 'refreshGoogleAccessToken');
    quotaSpy = vi.spyOn(apiModule, 'fetchGoogleQuotaBuckets');
    modelsSpy = vi.spyOn(apiModule, 'fetchGoogleModels');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns configured:false when no auth sources', async () => {
    authSpy.mockReturnValue([]);
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
  });

  it('emits usage.accounts[] with one entry per antigravity account', async () => {
    authSpy.mockReturnValue([
      {
        sourceId: 'antigravity',
        sourceLabel: 'Antigravity',
        refreshToken: 'rt-a',
        projectId: 'proj-a',
        email: 'alice@example.com'
      },
      {
        sourceId: 'antigravity',
        sourceLabel: 'Antigravity',
        refreshToken: 'rt-b',
        projectId: 'proj-b',
        email: 'bob@example.com'
      }
    ]);
    refreshSpy.mockResolvedValue('access-token');
    // Each account gets its own quota fetch; return distinct fixtures.
    quotaSpy
      .mockResolvedValueOnce({ buckets: [
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.8, resetTime: '2026-06-27T20:00:00Z' }
      ] })
      .mockResolvedValueOnce({ buckets: [
        { modelId: 'claude-sonnet-4', remainingFraction: 0.4, resetTime: '2026-06-27T23:00:00Z' }
      ] });
    modelsSpy.mockResolvedValue(null);

    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.accounts).toBeTruthy();
    expect(result.usage.accounts).toHaveLength(2);

    const alice = result.usage.accounts[0];
    expect(alice.accountKey).toBe('alice@example.com');
    expect(alice.label).toBe('alice@example.com');
    expect(alice.subtitle).toBe('alice@example.com');
    expect(alice.windows['Gemini Pro']).toBeTruthy();
    expect(alice.windows['Gemini Pro'].remainingPercent).toBe(80);

    const bob = result.usage.accounts[1];
    expect(bob.accountKey).toBe('bob@example.com');
    expect(bob.windows.Claude).toBeTruthy();
    expect(bob.windows.Claude.remainingPercent).toBe(40);

    // Top-level windows come from the first account.
    expect(result.usage.windows['Gemini Pro']).toBeTruthy();
  });

  it('skips accounts that yield no quota buckets', async () => {
    authSpy.mockReturnValue([
      {
        sourceId: 'antigravity',
        sourceLabel: 'Antigravity',
        refreshToken: 'rt-empty',
        projectId: 'proj-empty',
        email: 'empty@example.com'
      }
    ]);
    refreshSpy.mockResolvedValue('access-token');
    quotaSpy.mockResolvedValueOnce({ buckets: [] });
    modelsSpy.mockResolvedValue(null);

    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('No quota buckets');
  });
});