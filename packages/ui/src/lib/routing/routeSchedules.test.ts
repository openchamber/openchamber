import { describe, expect, test } from 'bun:test';

import {
  isTimezone,
  parseDaysOfMonth,
  parseList,
  readScheduleList,
  scheduleListValue,
  timeInputValue,
  toggleWeekday,
  windowWeekdays,
  withScheduleEffect,
} from './routeSchedules';

describe('weekdays', () => {
  test('reads names in any form OpenCode accepts, and numbers, skipping what it cannot read', () => {
    expect(windowWeekdays({ daysOfWeek: ['monday', 'tues', 5, 'Mon', 9] })).toEqual([1, 2, 5, 1]);
    expect(windowWeekdays(undefined)).toEqual([]);
  });

  test('reads case-insensitive, trimmed names and numeric strings', () => {
    expect(windowWeekdays({ daysOfWeek: ['Mon', '5', ' fri '] })).toEqual([1, 5, 5]);
  });

  test('a toggle writes short names in week order, and the last day off removes the field', () => {
    expect(toggleWeekday({ daysOfWeek: ['friday'], start: '09:00' }, 1)).toEqual({ daysOfWeek: ['mon', 'fri'], start: '09:00' });
    expect(toggleWeekday({ daysOfWeek: ['fri'], start: '09:00' }, 5)).toEqual({ start: '09:00' });
    expect(toggleWeekday(undefined, 0)).toEqual({ daysOfWeek: ['sun'] });
  });

  test('preserves unreadable stored days when toggling a readable weekday', () => {
    expect(toggleWeekday({ daysOfWeek: ['Mon', 'fri', 9] }, 0)).toEqual({ daysOfWeek: ['sun', 'mon', 'fri', 9] });
    expect(toggleWeekday({ daysOfWeek: ['Mon', 9] }, 1)).toEqual({ daysOfWeek: [9] });
  });
});

describe('form text', () => {
  test('lists drop blanks, and an empty list is unset', () => {
    expect(parseList(' a/*, , b ')).toEqual(['a/*', 'b']);
    expect(parseList(' , ')).toBeUndefined();
  });

  test('days of the month accept 1 to 31 and -1, and refuse anything else', () => {
    expect(parseDaysOfMonth('1, 15, -1')).toEqual([1, 15, -1]);
    expect(parseDaysOfMonth('')).toBeUndefined();
    expect(parseDaysOfMonth('0')).toBeNull();
    expect(parseDaysOfMonth('32')).toBeNull();
    expect(parseDaysOfMonth('1.5')).toBeNull();
    expect(parseDaysOfMonth('first')).toBeNull();
  });

  test('timezones are checked against the runtime', () => {
    expect(isTimezone('America/Chicago')).toBe(true);
    expect(isTimezone('UTC')).toBe(true);
    expect(isTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('withScheduleEffect', () => {
  test('keeps exactly one of factor and weight', () => {
    expect(withScheduleEffect({ when: {}, factor: 0.5, weight: 3 }, 'weight', 2)).toEqual({ when: {}, weight: 2 });
    expect(withScheduleEffect({ when: {}, weight: 3 }, 'factor', 0.5)).toEqual({ when: {}, factor: 0.5 });
  });
});

describe('timeInputValue', () => {
  test('pads a stored time to what a time input holds, keeping seconds', () => {
    expect(timeInputValue('9:30')).toBe('09:30');
    expect(timeInputValue('9:5')).toBe('09:05');
    expect(timeInputValue('09:30:5')).toBe('09:30:05');
    expect(timeInputValue(' 17:05:15 ')).toBe('17:05:15');
    expect(timeInputValue(undefined)).toBe('');
  });

  test('is null for a time OpenCode could not read', () => {
    expect(timeInputValue('24:00')).toBeNull();
    expect(timeInputValue('12:60')).toBeNull();
    expect(timeInputValue('09:30:60')).toBeNull();
    expect(timeInputValue('09:30:99')).toBeNull();
    expect(timeInputValue('12:00:61')).toBeNull();
    expect(timeInputValue('noon')).toBeNull();
    expect(timeInputValue('')).toBeNull();
  });
});

describe('readScheduleList', () => {
  test('reads entries one by one, keeps the unreadable ones as stored, and writes both back', () => {
    const unreadable = { when: { start: 900 }, factor: 2 };
    const readable = { providers: ['p'], when: {}, factor: 0.5, future: true };
    const entries = readScheduleList([unreadable, readable]);
    expect(entries?.map((entry) => entry.kind)).toEqual(['stored', 'schedule']);
    expect(entries === null ? null : scheduleListValue(entries)).toEqual([unreadable, readable]);
  });

  test('unset is an empty list, and a value that is not a list is null', () => {
    expect(readScheduleList(undefined)).toEqual([]);
    expect(readScheduleList(null)).toEqual([]);
    expect(readScheduleList({ start: '09:00' })).toBeNull();
  });
});
