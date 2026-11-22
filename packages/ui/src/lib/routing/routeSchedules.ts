import {
  globalScheduleSchema,
  type GlobalSchedule,
  type ScheduleList,
  type ScheduleListValue,
  type ScheduleWindow,
} from '@/lib/routing/scheduleSchema';

/** One entry of a stored list: a schedule the editor can read, or the stored value it cannot. */
export type ScheduleEntry = { kind: 'schedule'; schedule: GlobalSchedule } | { kind: 'stored'; stored: ScheduleListValue[number] };

/**
 * Reads a stored schedule list entry by entry. Unset is an empty list; a value
 * that is not a list at all is null. An entry the editor cannot read is kept as
 * stored, so a save writes it back unchanged and the server names its problem.
 */
export const readScheduleList = (stored: ScheduleList | null | undefined): ScheduleEntry[] | null => {
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored)) return null;
  const items: ScheduleListValue = stored;
  return items.map((item): ScheduleEntry => {
    const parsed = globalScheduleSchema.safeParse(item);
    return parsed.success ? { kind: 'schedule', schedule: parsed.data } : { kind: 'stored', stored: item };
  });
};

export const scheduleListValue = (entries: readonly ScheduleEntry[]): ScheduleListValue =>
  entries.map((entry) => (entry.kind === 'schedule' ? entry.schedule : entry.stored));

// OpenCode reads "9:30", "09:30", "09:30:15" and "09:30:5" (`minutesOf` in packages/core/src/model-route-schedule.ts).
const STORED_TIME = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

/**
 * A stored time as `<input type="time">` holds it: zero-padded HH:mm, seconds
 * zero-padded and kept. Unset is ''. Null when the text is no time OpenCode
 * could read; such a value would show as an empty time input and be erased on
 * the next blur.
 */
export const timeInputValue = (stored: string | undefined): string | null => {
  if (stored === undefined) return '';
  const match = STORED_TIME.exec(stored.trim());
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (Number(hours) > 23 || Number(minutes) > 59 || (seconds !== undefined && Number(seconds) > 59)) return null;
  const padded = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  return seconds === undefined ? padded : `${padded}:${seconds.padStart(2, '0')}`;
};

/** The day names OpenCode accepts, by weekday number, 0 for Sunday. Written back as the short form. */
const SHORT_DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const DAY_NUMBERS = new Map<string, number>([
  ['sun', 0],
  ['sunday', 0],
  ['mon', 1],
  ['monday', 1],
  ['tue', 2],
  ['tues', 2],
  ['tuesday', 2],
  ['wed', 3],
  ['wednesday', 3],
  ['thu', 4],
  ['thur', 4],
  ['thurs', 4],
  ['thursday', 4],
  ['fri', 5],
  ['friday', 5],
  ['sat', 6],
  ['saturday', 6],
]);

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

// OpenCode trims and lowercases names and accepts numeric strings from 0 to 6.
const dayNumber = (day: string | number): number | undefined => {
  const normalized = String(day).trim().toLowerCase();
  const namedDay = DAY_NUMBERS.get(normalized);
  if (namedDay !== undefined) return namedDay;
  return /^[0-6]$/.test(normalized) ? Number(normalized) : undefined;
};

/** The weekdays a window names, as numbers; entries the editor cannot read are left out. */
export const windowWeekdays = (window: ScheduleWindow | undefined): number[] =>
  (window?.daysOfWeek ?? []).flatMap((day) => {
    const number = dayNumber(day);
    return number === undefined ? [] : [number];
  });

/** Turns one weekday on or off, keeping stored days the editor cannot read. */
export const toggleWeekday = (window: ScheduleWindow | undefined, day: number): ScheduleWindow => {
  const storedDays = window?.daysOfWeek ?? [];
  const current = new Set(windowWeekdays(window));
  const unreadableDays = storedDays.filter((storedDay) => dayNumber(storedDay) === undefined);
  if (current.has(day)) current.delete(day);
  else current.add(day);
  const days: (string | number)[] = [...current]
    .sort((left, right) => left - right)
    .map((number) => SHORT_DAY_NAMES[number]);
  days.push(...unreadableDays);
  return withWindowField(window, 'daysOfWeek', days.length > 0 ? days : undefined);
};

/** Sets or removes one window field; an undefined value removes it. */
export const withWindowField = <K extends keyof ScheduleWindow>(
  window: ScheduleWindow | undefined,
  key: K,
  value: ScheduleWindow[K] | undefined,
): ScheduleWindow => {
  const next: ScheduleWindow = { ...(window ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** A comma-separated list as trimmed entries, without blanks; an empty list is undefined. */
export const parseList = (text: string): string[] | undefined => {
  const items = text.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/**
 * Days of the month typed as "1, 15, -1". Returns undefined for an empty field
 * (every day) and null when an entry is not 1 to 31 or -1.
 */
export const parseDaysOfMonth = (text: string): number[] | undefined | null => {
  const items = parseList(text);
  if (!items) return undefined;
  const days = items.map(Number);
  return days.every((day) => day === -1 || (Number.isInteger(day) && day >= 1 && day <= 31)) ? days : null;
};

/** Whether the runtime knows an IANA timezone name. */
export const isTimezone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

type ScheduleEffect = 'factor' | 'weight';

export const scheduleEffect = (schedule: GlobalSchedule): ScheduleEffect => (schedule.weight !== undefined ? 'weight' : 'factor');

/** Sets the schedule's change as a factor or an outright weight; the other one is removed. */
export const withScheduleEffect = (schedule: GlobalSchedule, effect: ScheduleEffect, value: number): GlobalSchedule => {
  const next: GlobalSchedule = { ...schedule };
  delete next.factor;
  delete next.weight;
  next[effect] = value;
  return next;
};

/** Sets or removes one schedule field; an undefined value removes it. */
export const withScheduleField = <K extends keyof GlobalSchedule>(
  schedule: GlobalSchedule,
  key: K,
  value: GlobalSchedule[K] | undefined,
): GlobalSchedule => {
  const next: GlobalSchedule = { ...schedule };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** A new entry: every day, all day, weight unchanged until the user picks a change. */
export const newSchedule = (): GlobalSchedule => ({ when: {}, factor: 1 });
