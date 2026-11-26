export type TimelineDay = {
  dayKey: string;
  dayStartMs: number;
  relation: 'today' | 'yesterday' | 'date';
  sameYear: boolean;
};

export type TimelineActivity = { kind: 'lead' } | { kind: 'unstarted' } | { kind: 'active'; at: number };

type TimelineSection<Entry> = { headed: boolean; day: TimelineDay | null; entries: Entry[] };

export const localDayStart = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

const pad = (value: number): string => String(value).padStart(2, '0');

export const timelineDayBucket = (timestampMs: number, todayStartMs: number): TimelineDay | null => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const dayStartMs = Math.min(localDayStart(timestampMs), todayStartMs);
  const date = new Date(dayStartMs);
  const relation = dayStartMs === todayStartMs
    ? 'today'
    : dayStartMs === localDayStart(todayStartMs - 1) ? 'yesterday' : 'date';
  return {
    dayKey: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    dayStartMs,
    relation,
    sameYear: date.getFullYear() === new Date(todayStartMs).getFullYear(),
  };
};

const headingAfter = (current: TimelineSection<unknown>, activity: TimelineActivity, todayStartMs: number): TimelineDay | null | undefined => {
  if (activity.kind === 'lead' || (current.headed && current.day === null)) return undefined;
  if (activity.kind === 'unstarted') return null;
  const day = timelineDayBucket(activity.at, todayStartMs);
  const olderThanCurrent = day !== null && (!current.headed || (current.day !== null && day.dayStartMs < current.day.dayStartMs));
  return olderThanCurrent ? day : undefined;
};

export const splitTimelineDays = <Entry extends { activity: TimelineActivity }>(
  entries: readonly Entry[],
  todayStartMs: number,
  runKeyOf: (entry: Entry) => string | undefined,
): TimelineSection<Entry>[] => {
  const sections: TimelineSection<Entry>[] = [];
  let current: TimelineSection<Entry> = { headed: false, day: null, entries: [] };
  let lastRunKey: string | undefined;
  for (const entry of entries) {
    const runKey = runKeyOf(entry);
    const continuesRun = runKey !== undefined && runKey === lastRunKey;
    lastRunKey = runKey;
    const heading = continuesRun ? undefined : headingAfter(current, entry.activity, todayStartMs);
    if (heading !== undefined) {
      if (current.entries.length > 0) sections.push(current);
      current = { headed: true, day: heading, entries: [] };
    }
    current.entries.push(entry);
  }
  if (current.entries.length > 0) sections.push(current);
  return sections;
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export const formatTimelineDate = (day: TimelineDay, intlLocale: string): string => {
  const cacheKey = `${intlLocale}\u0000${day.sameYear}`;
  let formatter = dateFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlLocale, day.sameYear
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    dateFormatters.set(cacheKey, formatter);
  }
  const [year, month, date] = day.dayKey.split('-').map(Number);
  return formatter.format(Date.UTC(year, month - 1, date));
};
