import { describe, expect, test } from 'bun:test';
import { ActivityStrip } from './ActivityStrip';
import { formatCompactNumber, type AnalyticsKpis, type HeatmapWeek } from '@/lib/analytics/aggregate';

const cell = (day: string, tokens = 0) => ({ day, tokens, level: 0 as const });
const weeks: HeatmapWeek[] = [
  [cell('2026-06-29'), cell('2026-06-30'), cell('2026-07-01'), cell('2026-07-02'), cell('2026-07-03'), cell('2026-07-04'), cell('2026-07-05')],
  [cell('2026-07-06'), cell('2026-07-07'), cell('2026-07-08'), cell('2026-07-09'), cell('2026-07-10'), cell('2026-07-11'), cell('2026-07-12')],
  [cell('2026-08-01', 5), cell('2026-08-02'), cell('2026-08-03'), cell('2026-08-04'), cell('2026-08-05'), cell('2026-08-06'), cell('2026-08-07')],
];

const kpis = {
  totalTokens: 445_000_000, totalCost: 0, sessionCount: 1, activeDays: 5,
  avgTokensPerActiveDay: 89_000_000, currentStreak: 2,
  prevTotalTokens: 0, prevTotalCost: 0, prevSessionCount: 0,
  cacheHitRate: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, longestStreak: 9, avgPerWeek: 104_000_000, totalCostAllTime: 0,
  reasoningShare: 0,
  avgSessionDurationMs: 0, medianSessionDurationMs: 0, longestSessionDurationMs: 0,
  costPerMillion: 0, costPerSession: 0, tokensPerSession: 0,
} satisfies AnalyticsKpis;

const labels = {
  metricCaption: 'Tokens', longestStreak: 'Longest streak', avgPerDay: 'Avg / day',
  avgPerWeek: 'Avg / week', total: 'Total', days: 'days',
  heatmap: { title: 'Activity', less: 'Less', more: 'More' },
};

describe('ActivityStrip', () => {
  test('renders inline stats', () => {
    const html = JSON.stringify(ActivityStrip({ weeks, kpis, labels }));
    expect(html).toContain(labels.longestStreak);
    expect(html).toContain(formatCompactNumber(kpis.totalTokens));
    expect(html).toContain(formatCompactNumber(kpis.avgTokensPerActiveDay));
  });
  test('passes weeks through to the heatmap', () => {
    const html = JSON.stringify(ActivityStrip({ weeks, kpis, labels }));
    expect(html).toContain('2026-08-01');
  });
});
