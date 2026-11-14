// How long a shared page lives: two working days in this server's local time
// zone, Saturday and Sunday skipped (public holidays are not). The laptop
// computes the absolute deadline and the relay only enforces it.

const HOUR_MS = 60 * 60 * 1000;
const SHARE_WORKING_DAYS = 2;
const WORKING_MS = SHARE_WORKING_DAYS * 24 * HOUR_MS;

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

const nextLocalMidnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();

/**
 * The moment `start` plus two working days' worth of weekday time ends: every
 * hour of Monday to Friday counts, weekends count nothing. Friday 17:00 ends
 * on Tuesday 17:00; a start on a weekend counts from Monday 00:00 and ends on
 * Wednesday 00:00. A day the clock changes on counts the hours it really has.
 */
export const workingDaysDeadline = (start) => {
  let cursor = start;
  let remaining = WORKING_MS;
  while (remaining > 0) {
    const date = new Date(cursor);
    const dayEnd = nextLocalMidnight(date);
    if (isWeekend(date)) {
      cursor = dayEnd;
      continue;
    }
    const step = Math.min(remaining, dayEnd - cursor);
    cursor += step;
    remaining -= step;
  }
  return cursor;
};

/**
 * The deadline of a share created at `start`. `hours` may only shorten the
 * two working days, never extend them.
 */
export const shareDeadline = (start, hours) => {
  const longest = workingDaysDeadline(start);
  if (hours === undefined) return longest;
  return Math.min(longest, start + Math.round(hours * HOUR_MS));
};
