import type { UsageStats } from '@/lib/opencode/session-stats';

export type UsageRange = '7d' | '30d' | '90d' | 'all';

export const USAGE_RANGES: readonly UsageRange[] = ['7d', '30d', '90d', 'all'];

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } satisfies Record<Exclude<UsageRange, 'all'>, number>;

/** Past this many days the chart groups days into weeks so bars stay readable. */
const MAX_DAILY_BARS = 92;

/**
 * Start of the range in epoch ms: local midnight, so "7 days" means today plus
 * the six calendar days before it, matching the day buckets OpenCode builds
 * in the viewer's time zone. `all` has no start; OpenCode begins at the
 * oldest message.
 */
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

/** Project name as the sidebar shows it: its label, else the folder name. */
export const projectDisplayName = (project: { label?: string | null; path: string }): string => {
  const label = project.label?.trim();
  if (label) return label;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? project.path;
};

/** Both timestamps fall on the same calendar day in the viewer's time zone. */
export const isSameLocalDay = (a: number, b: number): boolean => dateKey(new Date(a)) === dateKey(new Date(b));
