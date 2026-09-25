import { describe, expect, test } from 'bun:test';

import { buildActivitySeries, isEmptyReport, isSameLocalDay, projectDisplayName, rangeStart } from './usageStatsModel';

const local = (year: number, month: number, day: number, hour = 0) => new Date(year, month - 1, day, hour).getTime();

describe('rangeStart', () => {
  test('starts at local midnight and counts today as the first day', () => {
    const now = new Date(2026, 8, 23, 15, 30);
    expect(rangeStart('7d', now)).toBe(local(2026, 9, 17));
    expect(rangeStart('30d', now)).toBe(local(2026, 8, 25));
    expect(rangeStart('all', now)).toBeUndefined();
  });
});

describe('buildActivitySeries', () => {
  test('fills inactive days with zero bars across the whole range', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 9, 1), to: local(2026, 9, 4, 12) },
      activity: [{ date: '2026-09-02', steps: 5 }, { date: '2026-09-04', steps: 2 }],
    });
    expect(series.unit).toBe('day');
    expect(series.bars.map((bar) => [bar.start, bar.steps])).toEqual([
      ['2026-09-01', 0],
      ['2026-09-02', 5],
      ['2026-09-03', 0],
      ['2026-09-04', 2],
    ]);
    expect(series.max).toBe(5);
  });

  test('treats the range end as exclusive', () => {
    const series = buildActivitySeries({ range: { from: local(2026, 9, 1), to: local(2026, 9, 3) }, activity: [] });
    expect(series.bars.map((bar) => bar.start)).toEqual(['2026-09-01', '2026-09-02']);
  });

  test('groups long ranges into weeks without losing steps', () => {
    const series = buildActivitySeries({
      range: { from: local(2026, 1, 1), to: local(2026, 9, 1) },
      activity: [{ date: '2026-01-01', steps: 3 }, { date: '2026-01-07', steps: 4 }, { date: '2026-08-31', steps: 1 }],
    });
    expect(series.unit).toBe('week');
    expect(series.bars[0]).toEqual({ start: '2026-01-01', end: '2026-01-07', steps: 7 });
    expect(series.bars.reduce((sum, bar) => sum + bar.steps, 0)).toBe(8);
    expect(series.bars[series.bars.length - 1].end).toBe('2026-08-31');
  });
});

test('a report with no prompts and no steps is empty', () => {
  expect(isEmptyReport({ prompts: 0, steps: 0 })).toBe(true);
  expect(isEmptyReport({ prompts: 1, steps: 0 })).toBe(false);
});

test('a project reads as its label, else its folder name', () => {
  expect(projectDisplayName({ label: ' Chamber ', path: '/code/openchamber' })).toBe('Chamber');
  expect(projectDisplayName({ path: '/code/openchamber/' })).toBe('openchamber');
  expect(projectDisplayName({ label: '', path: 'C:\\code\\app' })).toBe('app');
});

test('same local day compares calendar dates, not 24 hours', () => {
  expect(isSameLocalDay(local(2026, 9, 23, 0), local(2026, 9, 23, 23))).toBe(true);
  expect(isSameLocalDay(local(2026, 9, 22, 23), local(2026, 9, 23, 0))).toBe(false);
});
