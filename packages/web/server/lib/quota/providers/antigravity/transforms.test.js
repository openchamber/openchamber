import { describe, expect, it } from 'vitest';
import {
  parseBucket,
  transformSummary,
  transformModels,
  FIVE_HOUR_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS
} from './transforms.js';

const MOCK_SUMMARY_PAYLOAD = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          resetTime: '2026-10-08T14:29:35Z',
          remainingFraction: 0.59
        },
        {
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          resetTime: '2026-10-04T07:31:51Z',
          remainingFraction: 1.0
        }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [
        {
          bucketId: '3p-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          resetTime: '2026-10-10T10:01:17Z',
          remainingFraction: 0.46
        },
        {
          bucketId: '3p-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          resetTime: '2026-10-04T07:31:51Z',
          remainingFraction: 0.8
        }
      ]
    }
  ]
};

const MOCK_MODELS_PAYLOAD = {
  models: {
    'gemini-3.8-flash': {
      displayName: 'Gemini 3.8 Flash',
      quotaInfo: { remainingFraction: 1.0, resetTime: '2026-10-04T07:31:51Z' }
    },
    'claude-sonnet-5-5-low': {
      displayName: 'Claude Sonnet 5.5 (Low)',
      quotaInfo: { remainingFraction: 0.46, resetTime: '2026-10-10T10:01:17Z' }
    }
  }
};

describe('Antigravity transforms', () => {
  it('parses buckets into standardized usage windows with 5h and weekly durations', () => {
    const weeklyBucket = parseBucket({
      bucketId: 'gemini-weekly',
      window: 'weekly',
      resetTime: '2026-10-08T14:29:35Z',
      remainingFraction: 0.6
    });

    expect(weeklyBucket.label).toBe('weekly');
    expect(weeklyBucket.seconds).toBe(WEEKLY_WINDOW_SECONDS);
    expect(weeklyBucket.window.remainingPercent).toBe(60);
    expect(weeklyBucket.window.usedPercent).toBe(40);
    expect(weeklyBucket.window.resetAt).toBe(Date.parse('2026-10-08T14:29:35Z'));

    const fiveHourBucket = parseBucket({
      bucketId: 'gemini-5h',
      window: '5h',
      resetTime: '2026-10-04T07:31:51Z',
      remainingFraction: 1.0
    });

    expect(fiveHourBucket.label).toBe('5h');
    expect(fiveHourBucket.seconds).toBe(FIVE_HOUR_WINDOW_SECONDS);
    expect(fiveHourBucket.window.remainingPercent).toBe(100);
    expect(fiveHourBucket.window.usedPercent).toBe(0);
  });

  it('parses summary groups into Gemini and 3P model-group windows', () => {
    const { modelGroupWindows } = transformSummary(MOCK_SUMMARY_PAYLOAD);

    expect(modelGroupWindows).toHaveLength(2);
    expect(modelGroupWindows[0].groupType).toBe('gemini');
    expect(modelGroupWindows[0].windows['5h'].remainingPercent).toBe(100);
    expect(modelGroupWindows[0].windows.weekly.remainingPercent).toBe(59);
    expect(modelGroupWindows[1].groupType).toBe('3p');
  });

  it('binds dual-layer quotas to individual Gemini and Claude models', () => {
    const { modelGroupWindows } = transformSummary(MOCK_SUMMARY_PAYLOAD);
    const models = transformModels(MOCK_MODELS_PAYLOAD, modelGroupWindows);

    // Gemini gets Gemini group's 5h and weekly
    const gemini = models['gemini-3.8-flash'];
    expect(gemini.windows['5h'].remainingPercent).toBe(100);
    expect(gemini.windows.weekly.remainingPercent).toBe(59);

    // Claude gets 3p group's 5h and weekly
    const claude = models['claude-sonnet-5-5-low'];
    expect(claude.windows['5h'].remainingPercent).toBe(80);
    expect(claude.windows.weekly.remainingPercent).toBe(46);
  });

  it('prioritizes weekly window first when weekly quota is exhausted (bottleneck ordering)', () => {
    const exhaustedPayload = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              resetTime: '2026-10-10T10:01:17Z',
              remainingFraction: 0.0 // Exhausted
            },
            {
              bucketId: '3p-5h',
              window: '5h',
              resetTime: '2026-10-04T07:31:51Z',
              remainingFraction: 1.0
            }
          ]
        }
      ]
    };

    const { modelGroupWindows } = transformSummary(exhaustedPayload);
    const models = transformModels(
      {
        models: {
          'claude-opus-5-5-high': {
            displayName: 'Claude Opus 5.5',
            quotaInfo: { remainingFraction: 0.0, resetTime: '2026-10-10T10:01:17Z' }
          }
        }
      },
      modelGroupWindows
    );

    const windowEntries = Object.entries(models['claude-opus-5-5-high'].windows);
    // Weekly should be first entry
    expect(windowEntries[0][0]).toBe('weekly');
    expect(windowEntries[0][1].remainingPercent).toBe(0);
  });
});
