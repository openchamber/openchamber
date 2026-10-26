import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAntigravityModels, fetchAntigravityQuotaSummary } from './api.js';
import { antigravityUserAgent } from './client.js';
import { transformModels, transformSummary } from './transforms.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const bucket = (window, remainingFraction) => ({
  bucketId: window,
  window,
  resetTime: '2026-10-25T10:00:00Z',
  remainingFraction
});

const GEMINI_GROUP = {
  displayName: 'Gemini Models',
  buckets: [bucket('5h', 0.9), bucket('weekly', 0.6)]
};

const THIRD_PARTY_GROUP = {
  displayName: 'Claude and GPT models',
  buckets: [bucket('5h', 0.8), bucket('weekly', 0.5)]
};

// Mirrors the gating measured in #5138: the daily host leaves out the Gemini
// group for a 1.x client and returns both groups for a current one.
const stubGoogle = () => {
  const requests = [];
  vi.stubGlobal('fetch', async (url, options) => {
    const headers = new Headers(options.headers);
    requests.push({ url, userAgent: headers.get('User-Agent') });
    expect(headers.get('Authorization')).toBe('Bearer test-access');
    expect(JSON.parse(options.body)).toEqual({ project: 'test-project' });

    if (url.endsWith(':retrieveUserQuotaSummary')) {
      const isCurrentClient = /^antigravity\/([2-9]|\d{2,})\./.test(headers.get('User-Agent') ?? '');
      return Response.json({ groups: isCurrentClient ? [GEMINI_GROUP, THIRD_PARTY_GROUP] : [THIRD_PARTY_GROUP] });
    }
    return Response.json({
      models: {
        'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.9 } },
        'claude-sonnet-5-5': { quotaInfo: { remainingFraction: 0.8 } }
      }
    });
  });
  return requests;
};

describe('Antigravity quota requests', () => {
  it('identifies as the current Antigravity client on both quota calls', async () => {
    const requests = stubGoogle();

    await fetchAntigravityQuotaSummary('test-access', 'test-project');
    await fetchAntigravityModels('test-access', 'test-project');

    expect(requests.map((request) => request.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
    ]);
    expect(requests.map((request) => request.userAgent)).toEqual([antigravityUserAgent(), antigravityUserAgent()]);
  });

  it('gets the Gemini group back, so Gemini and Claude rows each show 5-hour and weekly limits', async () => {
    stubGoogle();

    const summary = await fetchAntigravityQuotaSummary('test-access', 'test-project');
    const models = await fetchAntigravityModels('test-access', 'test-project');
    const rows = transformModels(models, transformSummary(summary).modelGroupWindows);

    expect(summary.groups.map((group) => group.displayName)).toEqual(['Gemini Models', 'Claude and GPT models']);
    expect(rows['gemini-3.8-flash'].windows['5h'].remainingPercent).toBe(90);
    expect(rows['gemini-3.8-flash'].windows.weekly.remainingPercent).toBe(60);
    expect(rows['claude-sonnet-5-5'].windows['5h'].remainingPercent).toBe(80);
    expect(rows['claude-sonnet-5-5'].windows.weekly.remainingPercent).toBe(50);
  });
});
