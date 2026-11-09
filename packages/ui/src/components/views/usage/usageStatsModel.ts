import type { UsageStats, UsageTokens } from '@/lib/opencode/session-stats';

export const USAGE_RANGES = ['1d', '7d', '30d', '90d', 'cycle', 'lastCycle', 'all'] as const;

export type UsageRange = (typeof USAGE_RANGES)[number];

const RANGE_DAYS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 } satisfies Record<'1d' | '7d' | '30d' | '90d', number>;

/** Past this many days the chart groups days into weeks so bars stay readable. */
const MAX_DAILY_BARS = 92;

type RangeWindow = { from?: number; to?: number };

/** The billing day in a month, or that month's last day when it is shorter. `month` may be out of 0..11. */
const billingDate = (year: number, month: number, billingDay: number): Date =>
  new Date(year, month, Math.min(billingDay, new Date(year, month + 1, 0).getDate()));

/** Local midnight of the billing day that opened the cycle `cyclesBack` cycles before the current one; negative counts forward. */
function cycleStart(now: Date, billingDay: number, cyclesBack: number): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const opened = billingDate(today.getFullYear(), today.getMonth(), billingDay) <= today ? 0 : -1;
  return billingDate(today.getFullYear(), today.getMonth() + opened - cyclesBack, billingDay);
}

/**
 * Window of the range in epoch ms: local midnight, so "7 days" means today
 * plus the six calendar days before it and "today" starts at this midnight,
 * matching the day buckets OpenCode builds in the viewer's time zone. `cycle`
 * is the whole billing cycle that holds today, from its billing day up to the
 * next one, so days still to come show as empty; `lastCycle` is the cycle
 * before it. An absent `from` starts at the oldest message (`all`); an absent
 * `to` means now.
 */
export function rangeWindow(range: UsageRange, now: Date, billingDay: number): RangeWindow {
  if (range === 'all') return {};
  if (range === 'cycle' || range === 'lastCycle') {
    const cyclesBack = range === 'cycle' ? 0 : 1;
    return {
      from: cycleStart(now, billingDay, cyclesBack).getTime(),
      to: cycleStart(now, billingDay, cyclesBack - 1).getTime(),
    };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (RANGE_DAYS[range] - 1));
  return { from: start.getTime() };
}

const dateKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export type ActivityBar = {
  /** First day of the bucket, `YYYY-MM-DD`. */
  start: string;
  /** Last day of the bucket; equals `start` for daily bars. */
  end: string;
  steps: number;
};

export type ActivitySeries = { unit: 'day' | 'week'; bars: ActivityBar[]; max: number };

/**
 * Every calendar day of the report range, active or not, so gaps read as
 * gaps. OpenCode lists active days only. Local dates are used because the
 * request sends the viewer's own time zone.
 */
export function buildActivitySeries(stats: Pick<UsageStats, 'range' | 'activity'>): ActivitySeries {
  const stepsByDay = new Map(stats.activity.map((day) => [day.date, day.steps]));
  const from = new Date(stats.range.from);
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  // `to` is exclusive.
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

/** Nothing happened in the range: no prompt and no model step. */
export const isEmptyReport = (stats: Pick<UsageStats, 'prompts' | 'steps'>): boolean =>
  stats.prompts === 0 && stats.steps === 0;

/** Share of prompt tokens served from the cache: reads over everything that
 * could have been a miss (cache reads plus cache writes plus fresh input).
 * Null when nothing entered the context, so callers can show a dash. */
export const cacheHitRate = (tokens: Pick<UsageTokens, 'input' | 'cacheRead' | 'cacheWrite'>): number | null => {
  const misses = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  return misses > 0 ? tokens.cacheRead / misses : null;
};

/** total / count, or null when there is nothing to divide by. */
export const averagePer = (total: number, count: number): number | null => (count > 0 ? total / count : null);

/** Succeeded calls over all completed calls; null when nothing completed. */
export const toolSuccessRate = (totals: { succeeded: number; failed: number }): number | null => {
  const completed = totals.succeeded + totals.failed;
  return completed > 0 ? totals.succeeded / completed : null;
};

/** Cost in USD per one million tokens, or null with no tokens at all. */
export const costPerMillionTokens = (cost: number, tokens: number): number | null =>
  (tokens > 0 ? (cost / tokens) * 1_000_000 : null);

/** Share of reasoning inside everything the model produced; null when it
 * produced nothing. */
export const reasoningShare = (tokens: Pick<UsageTokens, 'output' | 'reasoning'>): number | null => {
  const produced = tokens.output + tokens.reasoning;
  return produced > 0 ? tokens.reasoning / produced : null;
};

export type TokenSegmentKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** One stacked-bar slice; zero values stay so legend order is stable. */
interface TokenSegment {
  key: TokenSegmentKey
  /** Output merges reasoning: the model's own production. */
  value: number
}

/** Token totals as stacked-bar segments in fixed order: fresh input, model
 * output plus reasoning, cache reads, cache writes. Zero segments stay in the
 * list so legend order is stable; renderers skip them. */
export const tokenSegments = (tokens: UsageTokens): TokenSegment[] => [
  { key: 'input', value: tokens.input },
  { key: 'output', value: tokens.output + tokens.reasoning },
  { key: 'cacheRead', value: tokens.cacheRead },
  { key: 'cacheWrite', value: tokens.cacheWrite },
];

/** Project name as the sidebar shows it: its label, else the folder name. */
export const projectDisplayName = (project: { label?: string | null; path: string }): string => {
  const label = project.label?.trim();
  if (label) return label;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? project.path;
};

/** Both timestamps fall on the same calendar day in the viewer's time zone. */
export const isSameLocalDay = (a: number, b: number): boolean => dateKey(new Date(a)) === dateKey(new Date(b));
