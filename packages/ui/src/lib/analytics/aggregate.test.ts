import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  aggregateAnalytics,
  computeSessionModelBreakdown,
  formatCompactNumber,
  formatCostUsd,
  sumSessionTokens,
} from './aggregate';

const NOW = new Date(2026, 7, 7, 12, 0, 0).getTime();

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  slug: 'ses-1',
  projectID: 'proj',
  directory: '/repo/app',
  title: 'Test session',
  version: '1',
  time: { created: NOW - 86_400_000, updated: NOW - 86_400_000 },
  ...overrides,
});

const withDay = (session: Session, daysAgo: number, tokens = 100, cost = 1): Session => ({
  ...session,
  cost,
  tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: {
    created: NOW - daysAgo * 86_400_000,
    updated: NOW - daysAgo * 86_400_000,
  },
});

const withDayBase = (session: Session, daysAgo: number): Session => ({
  ...session,
  time: { created: NOW - daysAgo * 86_400_000, updated: NOW - daysAgo * 86_400_000 },
});

describe('sumSessionTokens', () => {
  test('sums all token buckets', () => {
    expect(sumSessionTokens(makeSession({
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    }))).toBe(21);
  });

  test('returns 0 when tokens are missing', () => {
    expect(sumSessionTokens(makeSession({ tokens: undefined }))).toBe(0);
  });
});

describe('aggregateAnalytics', () => {
  test('filters by directory scope', () => {
    const sessions = [
      withDay(makeSession({ id: 'a', directory: '/repo/app' }), 1),
      withDay(makeSession({ id: 'b', directory: '/repo/other' }), 1),
    ];
    const vm = aggregateAnalytics(sessions, {
      period: '30d',
      scope: { kind: 'directory', directory: '/repo/app' },
      now: NOW,
    });
    expect(vm.kpis.sessionCount).toBe(1);
  });

  test('filters sessions older than the period by time.updated', () => {
    const sessions = [
      withDay(makeSession({ id: 'recent' }), 2),
      withDay(makeSession({ id: 'old' }), 40),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.sessionCount).toBe(1);
    expect(vm.kpis.totalTokens).toBe(100);
  });

  test("'all' period includes every session", () => {
    const sessions = [withDay(makeSession({ id: 'old' }), 400)];
    const vm = aggregateAnalytics(sessions, { period: 'all', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.sessionCount).toBe(1);
  });

  test('produces a dense daily series with zero-filled days', () => {
    const vm = aggregateAnalytics([withDay(makeSession(), 2)], {
      period: '7d', scope: { kind: 'all' }, now: NOW,
    });
    expect(vm.daily).toHaveLength(7);
    expect(vm.daily.filter((d) => d.sessions === 1)).toHaveLength(1);
    expect(vm.daily.reduce((acc, d) => acc + d.tokens, 0)).toBe(100);
  });

  test('streak counts consecutive active days, tolerating an empty today', () => {
    const sessions = [
      withDay(makeSession({ id: '1' }), 1),
      withDay(makeSession({ id: '2' }), 2),
      withDay(makeSession({ id: '3' }), 3),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.currentStreak).toBe(3);
    expect(vm.kpis.activeDays).toBe(3);
  });

  test('streak is 0 when the most recent activity is older than yesterday', () => {
    const sessions = [withDay(makeSession({ id: '1' }), 5)];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.currentStreak).toBe(0);
  });

  test('groups models by provider/id with share of total tokens', () => {
    const sessions = [
      withDay(makeSession({ id: '1', model: { id: 'glm-5.2', providerID: 'zai' } }), 1, 300),
      withDay(makeSession({ id: '2', model: { id: 'glm-5.2', providerID: 'zai' } }), 1, 100),
      withDay(makeSession({ id: '3' }), 1, 100),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.models[0]).toMatchObject({ key: 'zai/glm-5.2', label: 'glm-5.2', tokens: 400 });
    expect(vm.models[0]!.share).toBeCloseTo(0.8);
    expect(vm.models[1]).toMatchObject({ key: 'unknown', tokens: 100 });
  });

  test('model shares sum to 100% of attributed tokens under partial attribution', () => {
    // sessionModelUsage attributes only a subset of a session's tokens to a
    // model. Shares must be relative to that attributed total, not the larger
    // session-level total, so they sum to 1.0.
    const sessions = [
      withDay(makeSession({ id: '1', model: { id: 'glm-5.2', providerID: 'zai' } }), 1, 1000),
    ];
    const sessionModelUsage = new Map([
      ['1', new Map([['zai/glm-5.2', { tokens: 200, cost: 0, reasoning: 0 }]])],
    ]);
    const vm = aggregateAnalytics(sessions, {
      period: '30d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    expect(vm.models[0]).toMatchObject({ key: 'zai/glm-5.2', tokens: 200 });
    expect(vm.models[0]!.share).toBeCloseTo(1.0);
    expect(vm.models.reduce((acc, m) => acc + m.share, 0)).toBeCloseTo(1.0);
  });

  test('heatmap levels scale against the max day and weeks are Monday-first', () => {
    const sessions = [
      withDay(makeSession({ id: 'big' }), 1, 1000),
      withDay(makeSession({ id: 'small' }), 2, 100),
    ];
    const vm = aggregateAnalytics(sessions, { period: '7d', scope: { kind: 'all' }, now: NOW });
    const cells = vm.heatmap.flat().filter((c) => c !== null);
    const big = cells.find((c) => c!.tokens === 1000)!;
    const small = cells.find((c) => c!.tokens === 100)!;
    const empty = cells.find((c) => c!.tokens === 0)!;
    expect(big.level).toBe(4);
    expect(small.level).toBeLessThan(4);
    expect(small.level).toBeGreaterThan(0);
    expect(empty.level).toBe(0);
    for (const week of vm.heatmap) expect(week).toHaveLength(7);
  });

  test('top sessions sort by cost desc, then tokens desc', () => {
    const sessions = [
      withDay(makeSession({ id: 'cheap' }), 1, 5000, 0.5),
      withDay(makeSession({ id: 'pricey' }), 1, 10, 9.9),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.topSessions.map((s) => s.id)).toEqual(['pricey', 'cheap']);
  });

  test('top sessions derive the project label from the directory basename', () => {
    const sessions = [withDay(makeSession({ id: 'a', directory: '/repo/openchamber' }), 1)];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.topSessions[0]!.projectLabel).toBe('openchamber');
  });

  test('a malformed session does not break the others', () => {
    const sessions = [
      withDay(makeSession({ id: 'good' }), 1),
      { id: 'broken' } as unknown as Session,
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.sessionCount).toBe(1);
  });
});

describe('formatting', () => {
  test('formatCompactNumber compacts thousands', () => {
    expect(formatCompactNumber(2_100_000_000)).toMatch(/2\.1/);
  });

  test('formatCostUsd renders USD', () => {
    expect(formatCostUsd(42.3)).toContain('42');
  });
});

describe('aggregateAnalytics phase 2 fields', () => {
  test('prev-window totals exclude the current period', () => {
    const sessions = [
      withDay(makeSession({ id: 'cur' }), 2, 100, 1),
      withDay(makeSession({ id: 'prev' }), 35, 200, 5),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.totalTokens).toBe(100);
    expect(vm.kpis.prevTotalTokens).toBe(200);
    expect(vm.kpis.prevTotalCost).toBe(5);
    expect(vm.kpis.prevSessionCount).toBe(1);
  });

  test("prev totals are zero for 'all' period", () => {
    const vm = aggregateAnalytics([withDay(makeSession(), 5)], { period: 'all', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.prevTotalTokens).toBe(0);
    expect(vm.kpis.prevSessionCount).toBe(0);
  });

  test('cache hit rate is cache.read / (input + cache.read)', () => {
    const session = makeSession({
      id: 'c',
      tokens: { input: 300, output: 0, reasoning: 0, cache: { read: 100, write: 0 } },
    });
    const vm = aggregateAnalytics([withDayBase(session, 1)], { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.cacheHitRate).toBeCloseTo(0.25);
    expect(vm.kpis.promptTokens).toBe(300);
    expect(vm.kpis.cacheReadTokens).toBe(100);
  });

  test('dailyBreakdown is dense and aligned with daily', () => {
    const vm = aggregateAnalytics([withDay(makeSession(), 2)], { period: '7d', scope: { kind: 'all' }, now: NOW });
    expect(vm.dailyBreakdown).toHaveLength(vm.daily.length);
    expect(vm.dailyBreakdown.every((b) => b.day.length > 0)).toBe(true);
  });

  test('byModelDaily folds non-top-5 models into other', () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      withDay(makeSession({ id: `m${i}`, model: { id: `model-${i}`, providerID: 'p' } }), 1, (i + 1) * 10, 0),
    );
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.topModelKeys).toHaveLength(5);
    const activeDay = vm.byModelDaily.find((d) => Object.keys(d.series).length > 0)!;
    expect(activeDay.series.other).toBeGreaterThan(0);
    expect(Object.keys(activeDay.series).some((k) => k === 'other')).toBe(true);
  });

  test('byModelDailyCost aggregates cost per model per day with other bucket', () => {
    const sessions = [
      withDay(makeSession({ id: 'a', model: { providerID: 'openai', id: 'gpt-5' } }), 0, 100, 1.5),
      withDay(makeSession({ id: 'b', model: { providerID: 'openai', id: 'gpt-5' } }), 0, 100, 0.5),
      withDay(makeSession({ id: 'm2', model: { providerID: 'p', id: 'm2' } }), 0, 100, 0),
      withDay(makeSession({ id: 'm3', model: { providerID: 'p', id: 'm3' } }), 0, 100, 0),
      withDay(makeSession({ id: 'm4', model: { providerID: 'p', id: 'm4' } }), 0, 100, 0),
      withDay(makeSession({ id: 'm5', model: { providerID: 'p', id: 'm5' } }), 0, 100, 0),
      withDay(makeSession({ id: 'lo', model: { providerID: 'p', id: 'low' } }), 0, 1, 7),
      withDay(makeSession({ id: 'lo2', model: { providerID: 'p', id: 'low' } }), 1, 1, 4),
    ];
    const vm = aggregateAnalytics(sessions, { period: '7d', scope: { kind: 'all' }, now: NOW });
    expect(vm.topModelKeys).toHaveLength(5);
    expect(vm.topModelKeys).not.toContain('p/low');
    const today = vm.byModelDailyCost.find((d) => d.day === vm.byModelDailyCost[vm.byModelDailyCost.length - 1]!.day)!;
    expect(today.series['openai/gpt-5']).toBe(2);
    expect(today.series.other).toBe(7);
    const yesterday = vm.byModelDailyCost[vm.byModelDailyCost.length - 2]!;
    expect(yesterday.series.other).toBe(4);
  });

  test('yearHeatmap spans up to a year and longestStreak is the max run', () => {
    const sessions = [
      withDay(makeSession({ id: 's1' }), 1, 10),
      withDay(makeSession({ id: 's2' }), 2, 10),
      withDay(makeSession({ id: 's3' }), 4, 10),
    ];
    const vm = aggregateAnalytics(sessions, { period: '7d', scope: { kind: 'all' }, now: NOW });
    expect(vm.yearHeatmap.length).toBeGreaterThan(0);
    expect(vm.kpis.longestStreak).toBeGreaterThanOrEqual(2);
  });

  test('yearHeatmap cells land in the column matching their weekday (no column shift)', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => withDay(makeSession({ id: `d${i}` }), i + 1, 10));
    const vm = aggregateAnalytics(sessions, { period: '7d', scope: { kind: 'all' }, now: NOW });
    for (const week of vm.yearHeatmap) {
      week.forEach((cell, dow) => {
        if (!cell) return;
        const [year, month, day] = cell.day.split('-').map(Number);
        const actualDow = (new Date(year!, (month ?? 1) - 1, day!).getDay() + 6) % 7;
        expect(actualDow).toBe(dow);
      });
    }
  });
});

describe('aggregateAnalytics wave1 additions', () => {
  const baseAt = (id: string, ts: number, extra: Partial<Session> = {}): Session => ({
    ...makeSession({ id }),
    cost: 1,
    tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: ts, updated: ts },
    ...extra,
  });

  test('byAgent aggregates tokens, sorts desc, and falls back to unknown', () => {
    const sessions = [
      withDay(makeSession({ id: 'a', agent: 'build' }), 1, 300, 1),
      withDay(makeSession({ id: 'b', agent: 'build' }), 1, 100, 1),
      withDay(makeSession({ id: 'c', agent: 'plan' }), 1, 500, 1),
      withDay(makeSession({ id: 'd' }), 1, 50, 1),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.byAgent.map((a) => a.agent)).toEqual(['plan', 'build', 'unknown']);
    const plan = vm.byAgent.find((a) => a.agent === 'plan')!;
    expect(plan.tokens).toBe(500);
    expect(plan.cost).toBe(1);
    expect(plan.sessions).toBe(1);
    const build = vm.byAgent.find((a) => a.agent === 'build')!;
    expect(build.tokens).toBe(400);
    expect(build.sessions).toBe(2);
    const unknown = vm.byAgent.find((a) => a.agent === 'unknown')!;
    expect(unknown.tokens).toBe(50);
  });

  test('byWeekdayHour is a 7x24 grid bucketing tokens by weekday and hour', () => {
    const ts = new Date(2026, 7, 6, 9, 30, 0).getTime();
    const session = baseAt('h', ts);
    const vm = aggregateAnalytics([session], { period: '7d', scope: { kind: 'all' }, now: NOW });
    const expectedHour = new Date(ts).getHours();
    const expectedDow = new Date(ts).getDay();
    expect(vm.byWeekdayHour).toHaveLength(7);
    expect(vm.byWeekdayHour.every((row) => row.length === 24)).toBe(true);
    expect(vm.byWeekdayHour[expectedDow][expectedHour]).toBe(100);
    const total = vm.byWeekdayHour.reduce((acc, row) => acc + row.reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(100);
  });

  test('duration stats exclude invalid/zero and compute mean/median/longest', () => {
    const t = NOW - 86_400_000;
    const mk = (id: string, created: number): Session => baseAt(id, t, { time: { created, updated: t } });
    const sessions = [
      mk('a', t - 1000),
      mk('b', t - 3000),
      mk('c', t - 5000),
      mk('d', t),
      mk('e', t),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.avgSessionDurationMs).toBeCloseTo((1000 + 3000 + 5000) / 3);
    expect(vm.kpis.medianSessionDurationMs).toBe(3000);
    expect(vm.kpis.longestSessionDurationMs).toBe(5000);
  });

  test('medianSessionDurationMs averages two middle values for even count', () => {
    const t = NOW - 86_400_000;
    const mk = (id: string, dur: number): Session => baseAt(id, t, { time: { created: t - dur, updated: t } });
    const vm = aggregateAnalytics([mk('a', 1000), mk('b', 2000), mk('c', 3000), mk('d', 4000)], {
      period: '30d', scope: { kind: 'all' }, now: NOW,
    });
    expect(vm.kpis.medianSessionDurationMs).toBe(2500);
  });

  test('reasoningShare and per-model reasoning', () => {
    const t = NOW - 86_400_000;
    const sessions = [
      baseAt('a', t, { model: { id: 'glm-5.2', providerID: 'zai' }, tokens: { input: 50, output: 25, reasoning: 25, cache: { read: 0, write: 0 } } }),
      baseAt('b', t, { model: { id: 'k3', providerID: 'anthropic' }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.reasoningShare).toBeCloseTo(0.25);
    const glm = vm.models.find((m) => m.key === 'zai/glm-5.2')!;
    expect(glm.reasoning).toBe(25);
  });

  test('reasoningShare and efficiency KPIs are 0 with no sessions', () => {
    const vm = aggregateAnalytics([], { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.reasoningShare).toBe(0);
    expect(vm.kpis.costPerMillion).toBe(0);
    expect(vm.kpis.costPerSession).toBe(0);
    expect(vm.kpis.tokensPerSession).toBe(0);
    expect(vm.kpis.avgSessionDurationMs).toBe(0);
    expect(vm.kpis.medianSessionDurationMs).toBe(0);
    expect(vm.kpis.longestSessionDurationMs).toBe(0);
  });

  test('costPerMillion/costPerSession/tokensPerSession from data', () => {
    const sessions = [
      withDay(makeSession({ id: 'a' }), 1, 100, 1),
      withDay(makeSession({ id: 'b' }), 1, 100, 1),
    ];
    const vm = aggregateAnalytics(sessions, { period: '30d', scope: { kind: 'all' }, now: NOW });
    expect(vm.kpis.costPerMillion).toBeCloseTo((2 / 200) * 1e6);
    expect(vm.kpis.costPerSession).toBeCloseTo(1);
    expect(vm.kpis.tokensPerSession).toBeCloseTo(100);
  });
});

describe('computeSessionModelBreakdown', () => {
  const mkMsg = (providerID: string, modelID: string, input: number, cost: number, reasoning = 0) => ({
    providerID,
    modelID,
    cost,
    tokens: { input, output: 0, reasoning, cache: { read: 0, write: 0 } },
  });

  test('groups messages by provider/model and sums tokens/cost/reasoning', () => {
    const breakdown = computeSessionModelBreakdown([
      mkMsg('zai', 'glm-5.2', 300, 0.5, 10),
      mkMsg('zai', 'glm-5.2', 200, 0.3, 5),
      mkMsg('opencode', 'deepseek-v4-flash-free', 100, 0),
    ]);
    expect(breakdown.size).toBe(2);
    const glm = breakdown.get('zai/glm-5.2')!;
    expect(glm.tokens).toBe(515); // (300+10) + (200+5) including reasoning
    expect(glm.cost).toBe(0.8);
    expect(glm.reasoning).toBe(15);
    const ds = breakdown.get('opencode/deepseek-v4-flash-free')!;
    expect(ds.tokens).toBe(100);
    expect(ds.cost).toBe(0);
  });

  test('skips messages without providerID or modelID', () => {
    const breakdown = computeSessionModelBreakdown([
      mkMsg('zai', 'glm-5.2', 100, 0),
      { providerID: '', modelID: 'x', cost: 0, tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    ]);
    expect(breakdown.size).toBe(1);
  });
});

describe('aggregateAnalytics per-message model attribution', () => {
  test('sessionModelUsage distributes tokens across models used in a session', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      1, 400, 0.5,
    );
    const sessionModelUsage = new Map([
      ['s1', new Map([
        ['zai/glm-5.2', { tokens: 300, cost: 0.5, reasoning: 0 }],
        ['opencode/deepseek-v4-flash-free', { tokens: 100, cost: 0, reasoning: 0 }],
      ])],
    ]);
    const vm = aggregateAnalytics([session], {
      period: '30d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const glm = vm.models.find((m) => m.key === 'zai/glm-5.2')!;
    const ds = vm.models.find((m) => m.key === 'opencode/deepseek-v4-flash-free')!;
    expect(glm.tokens).toBe(300);
    expect(glm.cost).toBe(0.5);
    expect(ds.tokens).toBe(100);
    expect(ds.cost).toBe(0);
  });

  test('without sessionModelUsage, all tokens go to session-level model (fallback)', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      1, 400, 0.5,
    );
    const vm = aggregateAnalytics([session], { period: '30d', scope: { kind: 'all' }, now: NOW });
    const models = vm.models.map((m) => m.key);
    expect(models).toContain('zai/glm-5.2');
    expect(models).not.toContain('opencode/deepseek-v4-flash-free');
    expect(vm.models[0]!.tokens).toBe(400);
  });

  test('partial coverage: sessions without breakdown fall back to session-level model', () => {
    const sessions = [
      withDay(makeSession({ id: 'with-breakdown', model: { id: 'glm-5.2', providerID: 'zai' } }), 1, 300, 0.3),
      withDay(makeSession({ id: 'no-breakdown', model: { id: 'k3', providerID: 'anthropic' } }), 1, 200, 0.2),
    ];
    const sessionModelUsage = new Map([
      ['with-breakdown', new Map([
        ['zai/glm-5.2', { tokens: 200, cost: 0.3, reasoning: 0 }],
        ['opencode/deepseek-v4-flash-free', { tokens: 100, cost: 0, reasoning: 0 }],
      ])],
    ]);
    const vm = aggregateAnalytics(sessions, {
      period: '30d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const keys = vm.models.map((m) => m.key);
    expect(keys).toContain('zai/glm-5.2');
    expect(keys).toContain('opencode/deepseek-v4-flash-free');
    expect(keys).toContain('anthropic/k3');
    const k3 = vm.models.find((m) => m.key === 'anthropic/k3')!;
    expect(k3.tokens).toBe(200);
    expect(k3.cost).toBe(0.2);
  });

  test('byModelDaily series reflect per-message model attribution', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      0, 400, 0.5,
    );
    const sessionModelUsage = new Map([
      ['s1', new Map([
        ['zai/glm-5.2', { tokens: 300, cost: 0.5, reasoning: 0 }],
        ['opencode/deepseek-v4-flash-free', { tokens: 100, cost: 0, reasoning: 0 }],
      ])],
    ]);
    const vm = aggregateAnalytics([session], {
      period: '7d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const today = vm.byModelDaily[vm.byModelDaily.length - 1]!;
    expect(today.series['zai/glm-5.2']).toBe(300);
    expect(today.series['opencode/deepseek-v4-flash-free']).toBe(100);
  });

  test('byModelDailyCost series reflect per-message cost attribution', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      0, 400, 0.5,
    );
    const sessionModelUsage = new Map([
      ['s1', new Map([
        ['zai/glm-5.2', { tokens: 300, cost: 0.5, reasoning: 0 }],
        ['openrouter/~deepseek/deepseek-v4-flash-latest', { tokens: 100, cost: 0.2, reasoning: 0 }],
      ])],
    ]);
    const vm = aggregateAnalytics([session], {
      period: '7d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const today = vm.byModelDailyCost[vm.byModelDailyCost.length - 1]!;
    expect(today.series['zai/glm-5.2']).toBe(0.5);
    expect(today.series['openrouter/~deepseek/deepseek-v4-flash-latest']).toBe(0.2);
  });

  test('sessions count is incremented per model used', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      1, 400, 0.5,
    );
    const sessionModelUsage = new Map([
      ['s1', new Map([
        ['zai/glm-5.2', { tokens: 300, cost: 0.5, reasoning: 0 }],
        ['opencode/deepseek-v4-flash-free', { tokens: 100, cost: 0, reasoning: 0 }],
      ])],
    ]);
    const vm = aggregateAnalytics([session], {
      period: '30d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const glm = vm.models.find((m) => m.key === 'zai/glm-5.2')!;
    const ds = vm.models.find((m) => m.key === 'opencode/deepseek-v4-flash-free')!;
    expect(glm.sessions).toBe(1);
    expect(ds.sessions).toBe(1);
  });

  test('overall KPI totals are unaffected by per-model attribution', () => {
    const session = withDay(
      makeSession({ id: 's1', model: { id: 'glm-5.2', providerID: 'zai' } }),
      1, 400, 0.5,
    );
    const sessionModelUsage = new Map([
      ['s1', new Map([
        ['zai/glm-5.2', { tokens: 300, cost: 0.5, reasoning: 0 }],
        ['opencode/deepseek-v4-flash-free', { tokens: 100, cost: 0, reasoning: 0 }],
      ])],
    ]);
    const vmWith = aggregateAnalytics([session], {
      period: '30d', scope: { kind: 'all' }, now: NOW, sessionModelUsage,
    });
    const vmWithout = aggregateAnalytics([session], {
      period: '30d', scope: { kind: 'all' }, now: NOW,
    });
    expect(vmWith.kpis.totalTokens).toBe(vmWithout.kpis.totalTokens);
    expect(vmWith.kpis.totalCost).toBe(vmWithout.kpis.totalCost);
    expect(vmWith.kpis.sessionCount).toBe(vmWithout.kpis.sessionCount);
  });
});
