import type { UsageStats, UsageTokens } from '@/lib/opencode/session-stats';

export type UsageRange = '1d' | '7d' | '30d' | '90d' | 'all';

export const USAGE_RANGES: readonly UsageRange[] = ['1d', '7d', '30d', '90d', 'all'];

const RANGE_DAYS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 } satisfies Record<Exclude<UsageRange, 'all'>, number>;

const MAX_DAILY_BARS = 92;

export function rangeStart(range: UsageRange, now: Date): number | undefined {
  if (range === 'all') return undefined;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (RANGE_DAYS[range] - 1));
  return start.getTime();
}

const dateKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export type ActivityBar = {
  start: string;
  end: string;
  from: number;
  to: number;
  steps: number;
};

export const bucketWindowKey = (from: number, to: number): string => `${from}:${to}`;

export type ActivitySeries = { unit: 'day' | 'week'; bars: ActivityBar[]; max: number };

export function buildActivitySeries(stats: Pick<UsageStats, 'range' | 'activity'>): ActivitySeries {
  const stepsByDay = new Map(stats.activity.map((day) => [day.date, day.steps]));
  const rangeFrom = new Date(stats.range.from);
  const cursor = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate());
  const last = new Date(stats.range.to - 1);
  const lastKey = dateKey(last);
  const days: ActivityBar[] = [];
  for (;;) {
    const key = dateKey(cursor);
    days.push({
      start: key,
      end: key,
      from: cursor.getTime(),
      to: new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1).getTime(),
      steps: stepsByDay.get(key) ?? 0,
    });
    if (key >= lastKey) break;
    cursor.setDate(cursor.getDate() + 1);
  }

  if (days.length <= MAX_DAILY_BARS) {
    return { unit: 'day', bars: days, max: Math.max(0, ...days.map((day) => day.steps)) };
  }

  const weeks: ActivityBar[] = [];
  for (let index = 0; index < days.length; index += 7) {
    const chunk = days.slice(index, index + 7);
    weeks.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      from: chunk[0].from,
      to: chunk[chunk.length - 1].to,
      steps: chunk.reduce((sum, day) => sum + day.steps, 0),
    });
  }
  return { unit: 'week', bars: weeks, max: Math.max(0, ...weeks.map((week) => week.steps)) };
}

export type ActivityAxisScale = { top: number; ticks: number[] };

export function activityAxisScale(max: number, integer: boolean): ActivityAxisScale {
  if (!(max > 0)) return { top: 1, ticks: [1, 0] };
  const rough = max / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / power;
  const niceStep = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * power;
  const step = integer ? Math.max(1, Math.ceil(niceStep)) : niceStep;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = top; value >= 0; value -= step) ticks.push(integer ? Math.round(value) : value);
  return { top, ticks };
}

export const isEmptyReport = (stats: Pick<UsageStats, 'prompts' | 'steps'>): boolean =>
  stats.prompts === 0 && stats.steps === 0;

export const cacheHitRate = (tokens: Pick<UsageTokens, 'input' | 'cacheRead' | 'cacheWrite'>): number | null => {
  const misses = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  return misses > 0 ? tokens.cacheRead / misses : null;
};

export const averagePer = (total: number, count: number): number | null => (count > 0 ? total / count : null);

export const toolSuccessRate = (totals: { succeeded: number; failed: number }): number | null => {
  const completed = totals.succeeded + totals.failed;
  return completed > 0 ? totals.succeeded / completed : null;
};

export const costPerMillionTokens = (cost: number, tokens: number): number | null =>
  (tokens > 0 ? (cost / tokens) * 1_000_000 : null);

export const reasoningShare = (tokens: Pick<UsageTokens, 'output' | 'reasoning'>): number | null => {
  const produced = tokens.output + tokens.reasoning;
  return produced > 0 ? tokens.reasoning / produced : null;
};

export type TokenSegmentKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

interface TokenSegment {
  key: TokenSegmentKey
  value: number
}

export const tokenSegments = (tokens: UsageTokens): TokenSegment[] => [
  { key: 'input', value: tokens.input },
  { key: 'output', value: tokens.output + tokens.reasoning },
  { key: 'cacheRead', value: tokens.cacheRead },
  { key: 'cacheWrite', value: tokens.cacheWrite },
];

export const projectDisplayName = (project: { label?: string | null; path: string }): string => {
  const label = project.label?.trim();
  if (label) return label;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? project.path;
};

export const isSameLocalDay = (a: number, b: number): boolean => dateKey(new Date(a)) === dateKey(new Date(b));
