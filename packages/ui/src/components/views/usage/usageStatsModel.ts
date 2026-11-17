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
  steps: number;
};

export type ActivitySeries = { unit: 'day' | 'week'; bars: ActivityBar[]; max: number };

export function buildActivitySeries(stats: Pick<UsageStats, 'range' | 'activity'>): ActivitySeries {
  const stepsByDay = new Map(stats.activity.map((day) => [day.date, day.steps]));
  const from = new Date(stats.range.from);
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(stats.range.to - 1);
  const lastKey = dateKey(last);
  const days: ActivityBar[] = [];
  for (;;) {
    const key = dateKey(cursor);
    days.push({ start: key, end: key, steps: stepsByDay.get(key) ?? 0 });
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
      steps: chunk.reduce((sum, day) => sum + day.steps, 0),
    });
  }
  return { unit: 'week', bars: weeks, max: Math.max(0, ...weeks.map((week) => week.steps)) };
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
