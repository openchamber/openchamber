import type { Session } from '@opencode-ai/sdk/v2';

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all';

export type AnalyticsScope =
  | { kind: 'all' }
  | { kind: 'directory'; directory: string };

export interface AggregateOptions {
  period: AnalyticsPeriod;
  scope: AnalyticsScope;
  now?: number;
  resolveDirectory?: (session: Session) => string | null;
  /**
   * Per-session model usage computed from message-level data, keyed by session ID.
   * When provided, model attribution uses per-message model identity instead of
   * the session-level model, correctly distributing tokens/cost across models used
   * within a single session. Sessions without an entry fall back to session-level model.
   */
  sessionModelUsage?: ReadonlyMap<string, SessionModelBreakdown>;
}

export interface AnalyticsKpis {
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
  activeDays: number;
  avgTokensPerActiveDay: number;
  currentStreak: number;
  prevTotalTokens: number;
  prevTotalCost: number;
  prevSessionCount: number;
  cacheHitRate: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  longestStreak: number;
  avgPerWeek: number;
  totalCostAllTime: number;
  reasoningShare: number;
  avgSessionDurationMs: number;
  medianSessionDurationMs: number;
  longestSessionDurationMs: number;
  costPerMillion: number;
  costPerSession: number;
  tokensPerSession: number;
}

export interface DailyBucket {
  day: string;
  tokens: number;
  cost: number;
  sessions: number;
}

export interface ModelUsageEntry {
  key: string;
  label: string;
  tokens: number;
  cost: number;
  sessions: number;
  share: number;
  reasoning: number;
}

export interface SessionModelBreakdownEntry {
  tokens: number;
  cost: number;
  reasoning: number;
}

/** Per-session map of model key → token/cost/reasoning breakdown. */
export type SessionModelBreakdown = ReadonlyMap<string, SessionModelBreakdownEntry>;

/** Minimal message shape compatible with SDK AssistantMessage for computing per-model usage. */
export interface MessageModelUsageInput {
  providerID: string;
  modelID: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

/**
 * Compute per-model token/cost/reasoning breakdown from assistant messages.
 * Returns a map keyed by `${providerID}/${modelID}`.
 * Messages without providerID/modelID are skipped.
 */
export const computeSessionModelBreakdown = (
  messages: ReadonlyArray<MessageModelUsageInput>,
): Map<string, SessionModelBreakdownEntry> => {
  const breakdown = new Map<string, SessionModelBreakdownEntry>();
  for (const msg of messages) {
    if (!msg || !msg.providerID || !msg.modelID) continue;
    const modelKey = `${msg.providerID}/${msg.modelID}`;
    const entry = breakdown.get(modelKey) ?? { tokens: 0, cost: 0, reasoning: 0 };
    const t = msg.tokens;
    entry.tokens +=
      (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) +
      (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);
    entry.cost += msg.cost ?? 0;
    entry.reasoning += t?.reasoning ?? 0;
    breakdown.set(modelKey, entry);
  }
  return breakdown;
};

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  day: string;
  tokens: number;
  level: HeatmapLevel;
}

export type HeatmapWeek = Array<HeatmapCell | null>;

export interface TopSessionEntry {
  id: string;
  title: string;
  tokens: number;
  cost: number;
  directory: string | null;
  /** Project display name derived from the directory basename. */
  projectLabel: string | null;
  updatedAt: number;
}

export interface DailyTokenBreakdown {
  day: string;
  prompt: number;
  completion: number;
  reasoning: number;
  cached: number;
}

export interface ByModelDaily {
  day: string;
  series: Record<string, number>;
}

export interface AgentUsageEntry {
  agent: string;
  tokens: number;
  cost: number;
  sessions: number;
}

export interface AnalyticsViewModel {
  kpis: AnalyticsKpis;
  daily: DailyBucket[];
  models: ModelUsageEntry[];
  heatmap: HeatmapWeek[];
  topSessions: TopSessionEntry[];
  dailyBreakdown: DailyTokenBreakdown[];
  byModelDaily: ByModelDaily[];
  byModelDailyCost: ByModelDaily[];
  topModelKeys: string[];
  byAgent: AgentUsageEntry[];
  byWeekdayHour: number[][];
  yearHeatmap: HeatmapWeek[];
}

const PERIOD_DAYS: Record<Exclude<AnalyticsPeriod, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const dayKeyOf = (timestamp: number): string => {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

const startOfLocalDay = (timestamp: number): number => {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Project display name from a directory: the final non-empty path segment. */
const projectLabelFromDirectory = (directory: string | null | undefined): string | null => {
  if (!directory) return null;
  return directory.split('/').filter(Boolean).pop() ?? directory;
};

const periodCutoff = (
  period: AnalyticsPeriod,
  now: number = Date.now(),
): number | null => {
  const periodDays = period === 'all' ? null : PERIOD_DAYS[period];
  return periodDays === null ? null : startOfLocalDay(now) - (periodDays - 1) * 86_400_000;
};

export const sumSessionTokens = (session: Session): number => {
  const tokens = session?.tokens;
  if (!tokens) return 0;
  return (
    (tokens.input ?? 0)
    + (tokens.output ?? 0)
    + (tokens.reasoning ?? 0)
    + (tokens.cache?.read ?? 0)
    + (tokens.cache?.write ?? 0)
  );
};

interface ModelUsageSlice {
  modelKey: string;
  modelID: string;
  tokens: number;
  cost: number;
  reasoning: number;
}

const MODEL_KEY_UNKNOWN = 'unknown';

const modelKeyFromParts = (providerID: string | undefined, modelID: string | undefined): string =>
  providerID && modelID ? `${providerID}/${modelID}` : modelID ?? MODEL_KEY_UNKNOWN;

const labelFromModelKey = (modelKey: string): string => {
  const slash = modelKey.lastIndexOf('/');
  return slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
};

/**
 * Resolve per-model token/cost/reasoning slices for a session.
 * Uses message-level breakdown when available; falls back to session-level model.
 */
const resolveModelUsageSlices = (
  session: Session,
  sessionModelUsage?: ReadonlyMap<string, SessionModelBreakdown>,
): ModelUsageSlice[] => {
  const breakdown = sessionModelUsage?.get(session.id);
  if (breakdown && breakdown.size > 0) {
    const slices: ModelUsageSlice[] = [];
    for (const [modelKey, entry] of breakdown) {
      slices.push({
        modelKey,
        modelID: labelFromModelKey(modelKey),
        tokens: entry.tokens,
        cost: entry.cost,
        reasoning: entry.reasoning,
      });
    }
    return slices;
  }
  return [{
    modelKey: modelKeyFromParts(session.model?.providerID, session.model?.id),
    modelID: session.model?.id ?? MODEL_KEY_UNKNOWN,
    tokens: sumSessionTokens(session),
    cost: session.cost ?? 0,
    reasoning: session.tokens?.reasoning ?? 0,
  }];
};

export function aggregateAnalytics(
  sessions: readonly Session[],
  options: AggregateOptions,
): AnalyticsViewModel {
  const now = options.now ?? Date.now();
  const resolveDirectory = options.resolveDirectory ?? ((s: Session) => s.directory ?? null);

  const scoped = sessions.filter((session) => {
    if (!session || typeof session !== 'object') return false;
    if (options.scope.kind === 'all') return true;
    try {
      return resolveDirectory(session) === options.scope.directory;
    } catch {
      return false;
    }
  });

  const startOfToday = startOfLocalDay(now);
  const cutoff = periodCutoff(options.period, now);
  const inRange = scoped.filter((session) => {
    const updated = session.time?.updated;
    if (typeof updated !== 'number' || !Number.isFinite(updated)) return false;
    return cutoff === null || updated >= cutoff;
  });

  const byDay = new Map<string, { tokens: number; cost: number; sessions: number }>();
  const byDayBreakdown = new Map<string, { prompt: number; completion: number; reasoning: number; cached: number }>();
  const byDayModel = new Map<string, Map<string, number>>();
  const byDayModelCost = new Map<string, Map<string, number>>();
  const modelPeriodTotals = new Map<string, number>();
  const byAgentMap = new Map<string, { tokens: number; cost: number; sessions: number }>();
  const byWeekdayHour = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const durations: number[] = [];

  for (const session of inRange) {
    const key = dayKeyOf(session.time.updated);

    const bucket = byDay.get(key) ?? { tokens: 0, cost: 0, sessions: 0 };
    bucket.tokens += sumSessionTokens(session);
    bucket.cost += session.cost ?? 0;
    bucket.sessions += 1;
    byDay.set(key, bucket);

    const bd = byDayBreakdown.get(key) ?? { prompt: 0, completion: 0, reasoning: 0, cached: 0 };
    const t = session.tokens;
    bd.prompt += t?.input ?? 0;
    bd.completion += t?.output ?? 0;
    bd.reasoning += t?.reasoning ?? 0;
    bd.cached += t?.cache?.read ?? 0;
    byDayBreakdown.set(key, bd);

    const modelSlices = resolveModelUsageSlices(session, options.sessionModelUsage);
    for (const slice of modelSlices) {
      const dayModel = byDayModel.get(key) ?? new Map<string, number>();
      dayModel.set(slice.modelKey, (dayModel.get(slice.modelKey) ?? 0) + slice.tokens);
      byDayModel.set(key, dayModel);
      const dayModelCost = byDayModelCost.get(key) ?? new Map<string, number>();
      dayModelCost.set(slice.modelKey, (dayModelCost.get(slice.modelKey) ?? 0) + slice.cost);
      byDayModelCost.set(key, dayModelCost);
      modelPeriodTotals.set(slice.modelKey, (modelPeriodTotals.get(slice.modelKey) ?? 0) + slice.tokens);
    }

    const sessionTokens = sumSessionTokens(session);

    const agentKey = session.agent ?? 'unknown';
    const agentEntry = byAgentMap.get(agentKey) ?? { tokens: 0, cost: 0, sessions: 0 };
    agentEntry.tokens += sessionTokens;
    agentEntry.cost += session.cost ?? 0;
    agentEntry.sessions += 1;
    byAgentMap.set(agentKey, agentEntry);

    const updatedDate = new Date(session.time.updated);
    byWeekdayHour[updatedDate.getDay()][updatedDate.getHours()] += sessionTokens;

    const created = session.time?.created;
    if (typeof created === 'number' && Number.isFinite(created) && created > 0) {
      const dur = session.time.updated - created;
      if (Number.isFinite(dur) && dur > 0) durations.push(dur);
    }

  }

  const firstTimestamp = cutoff ?? (
    inRange.length > 0
      ? Math.min(...inRange.map((s) => s.time.updated))
      : startOfToday
  );
  const seriesStart = startOfLocalDay(firstTimestamp);
  const daily: DailyBucket[] = [];
  const cursor = new Date(seriesStart);
  while (cursor.getTime() <= startOfToday) {
    const key = dayKeyOf(cursor.getTime());
    const bucket = byDay.get(key);
    daily.push({
      day: key,
      tokens: bucket?.tokens ?? 0,
      cost: bucket?.cost ?? 0,
      sessions: bucket?.sessions ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalTokens = inRange.reduce((acc, s) => acc + sumSessionTokens(s), 0);
  const totalCost = inRange.reduce((acc, s) => acc + (s.cost ?? 0), 0);

  const promptTokens = inRange.reduce((acc, s) => acc + (s.tokens?.input ?? 0), 0);
  const completionTokens = inRange.reduce((acc, s) => acc + (s.tokens?.output ?? 0), 0);
  const reasoningTokens = inRange.reduce((acc, s) => acc + (s.tokens?.reasoning ?? 0), 0);
  const cacheReadTokens = inRange.reduce((acc, s) => acc + (s.tokens?.cache?.read ?? 0), 0);
  const cacheWriteTokens = inRange.reduce((acc, s) => acc + (s.tokens?.cache?.write ?? 0), 0);
  const cacheHitRate = (promptTokens + cacheReadTokens) > 0
    ? cacheReadTokens / (promptTokens + cacheReadTokens)
    : 0;

  let prevTotalTokens = 0;
  let prevTotalCost = 0;
  let prevSessionCount = 0;
  if (cutoff !== null) {
    const periodDays = PERIOD_DAYS[options.period as Exclude<AnalyticsPeriod, 'all'>];
    const prevCutoff = cutoff - periodDays * 86_400_000;
    for (const session of scoped) {
      const updated = session.time?.updated;
      if (typeof updated !== 'number' || !Number.isFinite(updated)) continue;
      if (updated >= prevCutoff && updated < cutoff) {
        prevTotalTokens += sumSessionTokens(session);
        prevTotalCost += session.cost ?? 0;
        prevSessionCount += 1;
      }
    }
  }
  const activeDayKeys = new Set(byDay.keys());
  const activeDays = activeDayKeys.size;
  let currentStreak = 0;
  const streakCursor = new Date(startOfToday);
  if (!activeDayKeys.has(dayKeyOf(streakCursor.getTime()))) {
    streakCursor.setDate(streakCursor.getDate() - 1);
  }
  while (activeDayKeys.has(dayKeyOf(streakCursor.getTime()))) {
    currentStreak += 1;
    streakCursor.setDate(streakCursor.getDate() - 1);
  }

  const byModel = new Map<string, ModelUsageEntry>();
  for (const session of inRange) {
    const slices = resolveModelUsageSlices(session, options.sessionModelUsage);
    for (const slice of slices) {
      const entry = byModel.get(slice.modelKey) ?? {
        key: slice.modelKey, label: slice.modelID, tokens: 0, cost: 0, sessions: 0, share: 0, reasoning: 0,
      };
      entry.tokens += slice.tokens;
      entry.cost += slice.cost;
      entry.sessions += 1;
      entry.reasoning += slice.reasoning;
      byModel.set(slice.modelKey, entry);
    }
  }
  // Share is "fraction of model-attributed tokens", not of the session-level
  // total: only assistant-message-attributed tokens carry a model, so dividing
  // by totalTokens would understate every share and they would not sum to 100%.
  const modelsRaw = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
  const attributedTotal = modelsRaw.reduce((acc, entry) => acc + entry.tokens, 0);
  const models = modelsRaw.map((entry) => ({
    ...entry,
    share: attributedTotal > 0 ? entry.tokens / attributedTotal : 0,
  }));

  const seriesStartDate = new Date(seriesStart);
  const mondayOffset = (seriesStartDate.getDay() + 6) % 7;
  const gridCursor = new Date(seriesStartDate);
  gridCursor.setDate(gridCursor.getDate() - mondayOffset);

  const rawCells: Array<{ day: string; tokens: number; inRange: boolean; dow: number }> = [];
  const todayTime = startOfToday;
  while (gridCursor.getTime() <= todayTime) {
    const ts = gridCursor.getTime();
    const key = dayKeyOf(ts);
    rawCells.push({
      day: key,
      tokens: byDay.get(key)?.tokens ?? 0,
      inRange: ts >= seriesStart,
      dow: (gridCursor.getDay() + 6) % 7,
    });
    gridCursor.setDate(gridCursor.getDate() + 1);
  }

  const maxDayTokens = rawCells.reduce((acc, c) => Math.max(acc, c.tokens), 0);
  const levelOf = (tokens: number): HeatmapLevel => {
    if (tokens <= 0 || maxDayTokens <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((tokens / maxDayTokens) * 4))) as HeatmapLevel;
  };

  const heatmap: HeatmapWeek[] = [];
  let week: HeatmapWeek = new Array<HeatmapCell | null>(7).fill(null);
  for (const cell of rawCells) {
    if (cell.dow === 0 && week.some((c) => c !== null)) {
      heatmap.push(week);
      week = new Array<HeatmapCell | null>(7).fill(null);
    }
    if (cell.inRange) {
      week[cell.dow] = { day: cell.day, tokens: cell.tokens, level: levelOf(cell.tokens) };
    }
  }
  if (week.some((c) => c !== null) || heatmap.length === 0) {
    heatmap.push(week);
  }

  const topSessions: TopSessionEntry[] = [...inRange]
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || sumSessionTokens(b) - sumSessionTokens(a))
    .slice(0, 10)
    .map((session) => {
      let projectDir: string | null = null;
      try { projectDir = resolveDirectory(session); } catch { projectDir = null; }
      return {
        id: session.id,
        title: session.title || session.id,
        tokens: sumSessionTokens(session),
        cost: session.cost ?? 0,
        directory: projectDir,
        projectLabel: projectLabelFromDirectory(projectDir),
        updatedAt: session.time.updated,
      };
    });

  const topModelKeys = [...modelPeriodTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);

  const dailyBreakdown: DailyTokenBreakdown[] = daily.map((bucket) => {
    const bd = byDayBreakdown.get(bucket.day) ?? { prompt: 0, completion: 0, reasoning: 0, cached: 0 };
    return { day: bucket.day, prompt: bd.prompt, completion: bd.completion, reasoning: bd.reasoning, cached: bd.cached };
  });

  const byModelDaily: ByModelDaily[] = daily.map((bucket) => {
    const dayModel = byDayModel.get(bucket.day);
    const series: Record<string, number> = {};
    if (dayModel) {
      let otherTokens = 0;
      for (const [modelKey, tokens] of dayModel) {
        if (topModelKeys.includes(modelKey)) {
          series[modelKey] = (series[modelKey] ?? 0) + tokens;
        } else {
          otherTokens += tokens;
        }
      }
      if (otherTokens > 0) series.other = (series.other ?? 0) + otherTokens;
    }
    return { day: bucket.day, series };
  });

  const byModelDailyCost: ByModelDaily[] = daily.map((bucket) => {
    const dayModel = byDayModelCost.get(bucket.day);
    const series: Record<string, number> = {};
    if (dayModel) {
      let otherCost = 0;
      for (const [modelKey, cost] of dayModel) {
        if (topModelKeys.includes(modelKey)) {
          series[modelKey] = (series[modelKey] ?? 0) + cost;
        } else {
          otherCost += cost;
        }
      }
      if (otherCost > 0) series.other = (series.other ?? 0) + otherCost;
    }
    return { day: bucket.day, series };
  });

  const byAgent: AgentUsageEntry[] = [...byAgentMap.entries()]
    .map(([agent, entry]) => ({ agent, tokens: entry.tokens, cost: entry.cost, sessions: entry.sessions }))
    .sort((a, b) => b.tokens - a.tokens);

  const reasoningShare = totalTokens > 0 ? reasoningTokens / totalTokens : 0;
  const sessionCount = inRange.length;
  const costPerMillion = totalTokens > 0 ? (totalCost / totalTokens) * 1e6 : 0;
  const costPerSession = sessionCount > 0 ? totalCost / sessionCount : 0;
  const tokensPerSession = sessionCount > 0 ? totalTokens / sessionCount : 0;

  const sortedDurations = [...durations].sort((a, b) => a - b);
  const durationCount = sortedDurations.length;
  const durationSum = durations.reduce((acc, d) => acc + d, 0);
  const avgSessionDurationMs = durationCount > 0 ? durationSum / durationCount : 0;
  const medianSessionDurationMs = durationCount === 0
    ? 0
    : durationCount % 2 === 1
      ? sortedDurations[(durationCount - 1) / 2]!
      : (sortedDurations[durationCount / 2 - 1]! + sortedDurations[durationCount / 2]!) / 2;
  const longestSessionDurationMs = durationCount > 0 ? sortedDurations[durationCount - 1]! : 0;

  const yearStart = startOfToday - 364 * 86_400_000;
  const yearStartLocal = startOfLocalDay(yearStart);
  const yearGridStartDate = new Date(yearStartLocal);
  yearGridStartDate.setDate(yearGridStartDate.getDate() - ((yearGridStartDate.getDay() + 6) % 7));
  const yearGridStart = yearGridStartDate.getTime();
  const byDayYear = new Map<string, number>();
  for (const session of scoped) {
    const updated = session.time?.updated;
    if (typeof updated !== 'number' || !Number.isFinite(updated)) continue;
    if (updated < yearGridStart) continue;
    const key = dayKeyOf(updated);
    byDayYear.set(key, (byDayYear.get(key) ?? 0) + sumSessionTokens(session));
  }

  const yearMax = Math.max(0, ...byDayYear.values());
  const yearLevelOf = (tokens: number): HeatmapLevel => {
    if (tokens <= 0 || yearMax <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil((tokens / yearMax) * 4))) as HeatmapLevel;
  };

  const yearHeatmap: HeatmapWeek[] = [];
  const yearGridCursor = new Date(yearGridStart);
  let yearWeek: HeatmapWeek = new Array<HeatmapCell | null>(7).fill(null);
  while (yearGridCursor.getTime() <= startOfToday || yearGridCursor.getDay() !== 1) {
    const ts = yearGridCursor.getTime();
    const key = dayKeyOf(ts);
    if (yearGridCursor.getDay() === 1 && yearWeek.some((c) => c !== null)) {
      yearHeatmap.push(yearWeek);
      yearWeek = new Array<HeatmapCell | null>(7).fill(null);
    }
    const tokens = byDayYear.get(key) ?? 0;
    yearWeek[(yearGridCursor.getDay() + 6) % 7] = { day: key, tokens, level: yearLevelOf(tokens) };
    yearGridCursor.setDate(yearGridCursor.getDate() + 1);
  }
  if (yearWeek.some((c) => c !== null)) yearHeatmap.push(yearWeek);

  let longestStreak = 0;
  let runStreak = 0;
  const streakScan = new Date(yearGridStart);
  while (streakScan.getTime() <= startOfToday) {
    if (byDayYear.has(dayKeyOf(streakScan.getTime()))) {
      runStreak += 1;
      longestStreak = Math.max(longestStreak, runStreak);
    } else {
      runStreak = 0;
    }
    streakScan.setDate(streakScan.getDate() + 1);
  }

  const periodDaysValue = options.period === 'all' ? 365 : PERIOD_DAYS[options.period as Exclude<AnalyticsPeriod, 'all'>];
  const weeksInPeriod = Math.max(1, Math.ceil(periodDaysValue / 7));
  const avgPerWeek = totalTokens / weeksInPeriod;
  const totalCostAllTime = scoped.reduce((acc, s) => acc + (s.cost ?? 0), 0);

  return {
    kpis: {
      totalTokens,
      totalCost,
      sessionCount: inRange.length,
      activeDays,
      avgTokensPerActiveDay: activeDays > 0 ? totalTokens / activeDays : 0,
      currentStreak,
      prevTotalTokens,
      prevTotalCost,
      prevSessionCount,
      cacheHitRate,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      longestStreak,
      avgPerWeek,
      totalCostAllTime,
      reasoningShare,
      avgSessionDurationMs,
      medianSessionDurationMs,
      longestSessionDurationMs,
      costPerMillion,
      costPerSession,
      tokensPerSession,
    },
    daily,
    models,
    heatmap,
    topSessions,
    dailyBreakdown,
    byModelDaily,
    byModelDailyCost,
    topModelKeys,
    byAgent,
    byWeekdayHour,
    yearHeatmap,
  };
}

export const formatCompactNumber = (value: number): string =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export const formatCostUsd = (value: number): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
