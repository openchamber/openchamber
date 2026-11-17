
const HOUR_MS = 60 * 60 * 1000;
const SHARE_WORKING_DAYS = 2;
const WORKING_MS = SHARE_WORKING_DAYS * 24 * HOUR_MS;

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

const nextLocalMidnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();

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

export const shareDeadline = (start, hours) => {
  const longest = workingDaysDeadline(start);
  if (hours === undefined) return longest;
  return Math.min(longest, start + Math.round(hours * HOUR_MS));
};
