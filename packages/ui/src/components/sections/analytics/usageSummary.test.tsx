import { describe, expect, test } from 'bun:test';
import { UsageSummary } from './UsageSummary';
import type { AnalyticsKpis, ByModelDaily, DailyBucket, ModelUsageEntry } from '@/lib/analytics/aggregate';

const kpis = {
  totalTokens: 445_000_000, totalCost: 0.09, sessionCount: 112, activeDays: 5,
  avgTokensPerActiveDay: 89_000_000, currentStreak: 2,
  prevTotalTokens: 400_000_000, prevTotalCost: 0.05, prevSessionCount: 100,
  cacheHitRate: 0.97, promptTokens: 1, completionTokens: 1, reasoningTokens: 1,
  cacheReadTokens: 1, cacheWriteTokens: 1, longestStreak: 9, avgPerWeek: 100, totalCostAllTime: 0.09,
  reasoningShare: 0,
  avgSessionDurationMs: 0, medianSessionDurationMs: 0, longestSessionDurationMs: 0,
  costPerMillion: 0, costPerSession: 0, tokensPerSession: 0,
} satisfies AnalyticsKpis;

const daily: DailyBucket[] = [
  { day: '2026-08-07', tokens: 10, cost: 0.01, sessions: 1 },
  { day: '2026-08-08', tokens: 20, cost: 0.02, sessions: 2 },
];
const byModelDaily: ByModelDaily[] = [
  { day: '2026-08-07', series: { 'openai/gpt-5': 8, other: 2 } },
  { day: '2026-08-08', series: { 'openai/gpt-5': 15, other: 5 } },
];
const byModelDailyCost: ByModelDaily[] = [
  { day: '2026-08-07', series: { 'openai/gpt-5': 0.01 } },
  { day: '2026-08-08', series: { 'openai/gpt-5': 0.02 } },
];
const models: ModelUsageEntry[] = [
  { key: 'openai/gpt-5', label: 'gpt-5', tokens: 23, cost: 0.03, sessions: 3, share: 1, reasoning: 0 },
];

const labels = {
  metrics: { tokens: 'Tokens', cost: 'Cost', sessions: 'Sessions' },
  view: { daily: 'Daily', total: 'Total' },
  viewAria: 'View',
  chartToggleAria: 'Toggle chart',
  chartTypeBar: 'Bar chart',
  chartTypeLine: 'Line chart',
  topModels: 'Top models', other: 'Other',
  deltaUp: '↑ {value}% vs prev period', deltaDown: '↓ {value}% vs prev period',
  deltaNew: 'New', deltaFlat: '—', ariaLabel: 'Usage summary chart',
};

const base = { kpis, daily, byModelDaily, byModelDailyCost, topModelKeys: ['openai/gpt-5'], models, labels, view: 'daily' as const, onChangeView: () => {} };

describe('UsageSummary', () => {
  test('big value reflects the selected metric (tokens default)', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'tokens', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(html).toContain('445M');
    expect(html).toContain('Top models');
    expect(html).toContain('gpt-5');
    expect(html).toContain('↑ 11% vs prev period');
  });
  test('cost metric formats big value as currency', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'cost', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(html).toContain('$0.09');
  });
  test('cost leader bar fills 100% of the track (max is the real max, not floored to 1)', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'cost', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(html).toContain('"width":"100%"');
  });
  test('sessions metric renders single-series bars', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'sessions', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(html).toContain('112');
  });
  test('delta hidden when disabled', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'tokens', onChangeMetric: () => {}, deltaEnabled: false }));
    expect(html).not.toContain('vs prev period');
  });
  test('resolveModelMeta supplies display name, reasoning icon and provider', () => {
    const html = JSON.stringify(UsageSummary({
      ...base,
      metric: 'tokens',
      onChangeMetric: () => {},
      deltaEnabled: true,
      resolveModelMeta: () => ({
        displayName: 'GPT-5 Pro',
        providerName: 'OpenAI',
        providerId: 'openai',
        reasoning: true,
      }),
    }));
    expect(html).toContain('GPT-5 Pro');
    expect(html).toContain('brain-ai-3');
    expect(html).toContain('OpenAI');
  });
  test('falls back to aggregate label when resolveModelMeta is absent', () => {
    const html = JSON.stringify(UsageSummary({ ...base, metric: 'tokens', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(html).toContain('gpt-5');
  });
  test('daily view renders the by-day chart, total view renders the donut instead', () => {
    const dailyHtml = JSON.stringify(UsageSummary({ ...base, metric: 'tokens', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(dailyHtml).toContain('Aug 7');
    const totalHtml = JSON.stringify(UsageSummary({ ...base, metric: 'tokens', view: 'total', onChangeMetric: () => {}, deltaEnabled: true }));
    expect(totalHtml).not.toContain('Aug 7');
    expect(totalHtml).toContain('"values":');
  });
});
