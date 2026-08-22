import { describe, expect, test } from 'bun:test';
import { StatCardRow } from './StatCardRow';
import type { AnalyticsKpis, DailyBucket, DailyTokenBreakdown } from '@/lib/analytics/aggregate';

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
const dailyBreakdown: DailyTokenBreakdown[] = [
  { day: '2026-08-07', prompt: 5, completion: 1, reasoning: 0, cached: 5 },
  { day: '2026-08-08', prompt: 10, completion: 1, reasoning: 0, cached: 10 },
];

const labels = {
  tokens: 'Tokens', cost: 'Cost', sessions: 'Sessions', cacheHitRate: 'Cache hit rate',
  activeDays: 'Active days', streak: 'Day streak',
  deltaUp: '↑ {value}% vs prev period', deltaDown: '↓ {value}% vs prev period',
  deltaNew: 'New', deltaFlat: '—',
};

describe('StatCardRow', () => {
  test('renders five cards with formatted values', () => {
    const html = JSON.stringify(StatCardRow({ kpis, daily, dailyBreakdown, deltaEnabled: true, labels }));
    expect(html).toContain('445M');
    expect(html).toContain('$0.09');
    expect(html).toContain('112');
    expect(html).toContain('97%');
    expect(html).toContain('Day streak');
  });
  test('renders up delta for tokens', () => {
    const html = JSON.stringify(StatCardRow({ kpis, daily, dailyBreakdown, deltaEnabled: true, labels }));
    expect(html).toContain('↑ 11% vs prev period');
  });
  test('delta disabled shows flat marker', () => {
    const html = JSON.stringify(StatCardRow({ kpis, daily, dailyBreakdown, deltaEnabled: false, labels }));
    expect(html).not.toContain('vs prev period');
  });
  test('sparklines render for tokens/cost/sessions/cache, not for active days', () => {
    const html = JSON.stringify(StatCardRow({ kpis, daily, dailyBreakdown, deltaEnabled: true, labels }));
    // Sparkline elements are function components: only their props serialize.
    expect((html.match(/"values"/g) ?? []).length).toBe(4);
  });
});
