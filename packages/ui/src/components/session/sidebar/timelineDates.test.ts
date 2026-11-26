import { afterEach, describe, expect, test } from 'bun:test';
import { formatTimelineDate, localDayStart, timelineDayBucket } from './timelineDates';

const originalTimeZone = process.env.TZ;
afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

const at = (year: number, month: number, day: number, hour = 12, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();

describe('timeline days', () => {
  const today = localDayStart(at(2026, 11, 25));

  test('names today and yesterday, and keeps the date for every day before', () => {
    expect(timelineDayBucket(at(2026, 11, 25, 0, 1), today)).toEqual({ dayKey: '2026-11-25', dayStartMs: today, relation: 'today', sameYear: true });
    expect(timelineDayBucket(at(2026, 11, 24, 23, 59), today)).toMatchObject({ dayKey: '2026-11-24', relation: 'yesterday', sameYear: true });
    expect(timelineDayBucket(at(2026, 3, 3), today)).toMatchObject({ dayKey: '2026-03-03', relation: 'date', sameYear: true });
    expect(timelineDayBucket(at(2025, 12, 31, 23), today)).toMatchObject({ dayKey: '2025-12-31', relation: 'date', sameYear: false });
  });

  test('a time from a clock running ahead counts as today', () => {
    expect(timelineDayBucket(at(2026, 11, 27), today)).toMatchObject({ dayKey: '2026-11-25', dayStartMs: today, relation: 'today' });
  });

  test('a missing or zero time has no day, so no list shows 1970', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(timelineDayBucket(value, today)).toBeNull();
  });

  test('yesterday is the calendar day before when the clocks change', () => {
    process.env.TZ = 'America/New_York';
    // 2026-03-08 has 23 hours: 24 hours before midnight on the 9th is still the 7th.
    const afterSpring = localDayStart(at(2026, 3, 9));
    expect(timelineDayBucket(at(2026, 3, 8, 0, 30), afterSpring)?.relation).toBe('yesterday');
    expect(timelineDayBucket(at(2026, 3, 7, 23, 30), afterSpring)?.relation).toBe('date');
    // 2026-11-01 has 25 hours: its first hour lies more than 24 hours before midnight on the 2nd.
    const afterFall = localDayStart(at(2026, 11, 2));
    expect(timelineDayBucket(at(2026, 11, 1, 0, 30), afterFall)).toMatchObject({ dayKey: '2026-11-01', relation: 'yesterday' });
    expect(timelineDayBucket(at(2026, 10, 31, 23, 30), afterFall)?.relation).toBe('date');
  });
});

describe('timeline date labels', () => {
  const today = localDayStart(at(2026, 11, 25));
  const thisYear = timelineDayBucket(at(2026, 3, 3), today);
  const lastYear = timelineDayBucket(at(2025, 12, 31), today);

  test('a date this year leaves the year out, an older one keeps it', () => {
    if (!thisYear || !lastYear) throw new Error('expected days');
    expect(formatTimelineDate(thisYear, 'en-US')).toBe('Mar 3');
    expect(formatTimelineDate(lastYear, 'en-US')).toBe('Dec 31, 2025');
  });

  test('a date keeps its calendar day after the device moves to another time zone', () => {
    process.env.TZ = 'America/New_York';
    const inNewYork = timelineDayBucket(at(2026, 3, 8), localDayStart(at(2026, 3, 9)));
    if (!inNewYork) throw new Error('expected a day');
    expect(formatTimelineDate(inNewYork, 'en-US')).toBe('Mar 8');
    process.env.TZ = 'Asia/Tokyo';
    const inTokyo = timelineDayBucket(at(2026, 3, 8), localDayStart(at(2026, 3, 9)));
    if (!inTokyo) throw new Error('expected a day');
    expect(formatTimelineDate(inTokyo, 'en-US')).toBe('Mar 8');
  });

  test('each language writes the date its own way, right-to-left ones included', () => {
    if (!thisYear || !lastYear) throw new Error('expected days');
    for (const locale of ['de-DE', 'ar-u-nu-latn', 'he-IL', 'zh-CN', 'uk-UA']) {
      const expected = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(thisYear.dayStartMs);
      expect(formatTimelineDate(thisYear, locale)).toBe(expected);
      expect(formatTimelineDate(thisYear, locale)).not.toContain('2026');
      expect(formatTimelineDate(lastYear, locale)).toContain('2025');
    }
    expect(formatTimelineDate(thisYear, 'de-DE')).toBe('3. März');
  });
});
