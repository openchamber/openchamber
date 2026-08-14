import type { QuotaProviderId } from '@/types';
import { resolveQuotaProviderId } from './providerAliases';

export type UsageMetricMode = 'tokens' | 'cost' | 'requests';
export type UsagePeriodDays = 7 | 30;

export interface SessionUsageSource {
  cost?: number | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  } | null;
  model?: { providerID?: string | null } | null;
  time?: { updated?: number | null; created?: number | null } | null;
}

export interface DailyUsagePoint {
  dayKey: string;
  dayStartMs: number;
  cost: number;
  tokens: number;
  requests: number;
  byProvider: Record<string, { cost: number; tokens: number; requests: number }>;
}

export interface ProviderPeriodTotals {
  providerId: QuotaProviderId;
  cost: number;
  tokens: number;
  requests: number;
}

export interface PeriodUsageSummary {
  rangeStartMs: number;
  rangeEndMs: number;
  previousStartMs: number;
  previousEndMs: number;
  days: DailyUsagePoint[];
  totals: { cost: number; tokens: number; requests: number };
  previousTotals: { cost: number; tokens: number; requests: number };
  byProvider: ProviderPeriodTotals[];
}

const dayKeyFromMs = (ms: number): string => {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const startOfLocalDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const sessionTokenTotal = (tokens: SessionUsageSource['tokens']): number => {
  if (!tokens) return 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + cacheRead + cacheWrite;
};

export const percentChange = (current: number, previous: number): number | null => {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    if (current === 0) return 0;
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
};

export const averageCostPer1kTokens = (cost: number, tokens: number): number | null => {
  if (!Number.isFinite(cost) || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (cost / tokens) * 1000;
};

const emptyDay = (dayStartMs: number): DailyUsagePoint => ({
  dayKey: dayKeyFromMs(dayStartMs),
  dayStartMs,
  cost: 0,
  tokens: 0,
  requests: 0,
  byProvider: {},
});

const accumulateSession = (
  target: { cost: number; tokens: number; requests: number },
  session: SessionUsageSource,
) => {
  const cost = typeof session.cost === 'number' && Number.isFinite(session.cost) ? Math.max(0, session.cost) : 0;
  const tokens = Math.max(0, sessionTokenTotal(session.tokens));
  target.cost += cost;
  target.tokens += tokens;
  target.requests += 1;
  return { cost, tokens };
};

export const buildPeriodUsageSummary = (
  sessions: readonly SessionUsageSource[],
  options: {
    periodDays: UsagePeriodDays;
    nowMs?: number;
    providerFilter?: QuotaProviderId | null;
  },
): PeriodUsageSummary => {
  const nowMs = options.nowMs ?? Date.now();
  const rangeEndMs = nowMs;
  const rangeStartMs = startOfLocalDay(nowMs) - (options.periodDays - 1) * 24 * 60 * 60 * 1000;
  const previousEndMs = rangeStartMs;
  const previousStartMs = rangeStartMs - options.periodDays * 24 * 60 * 60 * 1000;

  const days: DailyUsagePoint[] = [];
  const dayIndex = new Map<string, DailyUsagePoint>();
  for (let offset = 0; offset < options.periodDays; offset += 1) {
    const dayStartMs = rangeStartMs + offset * 24 * 60 * 60 * 1000;
    const point = emptyDay(dayStartMs);
    days.push(point);
    dayIndex.set(point.dayKey, point);
  }

  const totals = { cost: 0, tokens: 0, requests: 0 };
  const previousTotals = { cost: 0, tokens: 0, requests: 0 };
  const providerTotals = new Map<QuotaProviderId, ProviderPeriodTotals>();

  for (const session of sessions) {
    const stamp = session.time?.updated ?? session.time?.created ?? null;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) continue;

    const providerId = resolveQuotaProviderId(session.model?.providerID ?? null);
    if (options.providerFilter && providerId !== options.providerFilter) continue;

    if (stamp >= rangeStartMs && stamp <= rangeEndMs) {
      const { cost, tokens } = accumulateSession(totals, session);
      const key = dayKeyFromMs(stamp);
      const day = dayIndex.get(key);
      if (day) {
        day.cost += cost;
        day.tokens += tokens;
        day.requests += 1;
        if (providerId) {
          const bucket = day.byProvider[providerId] ?? { cost: 0, tokens: 0, requests: 0 };
          bucket.cost += cost;
          bucket.tokens += tokens;
          bucket.requests += 1;
          day.byProvider[providerId] = bucket;

          const provider = providerTotals.get(providerId) ?? {
            providerId,
            cost: 0,
            tokens: 0,
            requests: 0,
          };
          provider.cost += cost;
          provider.tokens += tokens;
          provider.requests += 1;
          providerTotals.set(providerId, provider);
        }
      }
      continue;
    }

    if (stamp >= previousStartMs && stamp < previousEndMs) {
      accumulateSession(previousTotals, session);
    }
  }

  const byProvider = Array.from(providerTotals.values()).sort((left, right) => right.cost - left.cost || right.tokens - left.tokens);

  return {
    rangeStartMs,
    rangeEndMs,
    previousStartMs,
    previousEndMs,
    days,
    totals,
    previousTotals,
    byProvider,
  };
};

export const formatCompactNumber = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 100) return String(Math.round(value));
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
};

export const formatUsd = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(digits)}`;
};

export const formatSignedUsd = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${prefix}${formatUsd(Math.abs(value))}`;
};

export const formatSignedCompact = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${prefix}${formatCompactNumber(Math.abs(value))}`;
};

export const formatPercentDelta = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded}%`;
};

const CHART_SERIES_COLORS = [
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-1)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export const colorForProviderIndex = (index: number): string =>
  CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
