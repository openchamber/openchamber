import { describe, expect, test } from 'bun:test';
import { YearHeatmapBlock } from './YearHeatmapBlock';
import type { HeatmapWeek } from '@/lib/analytics/aggregate';

describe('YearHeatmapBlock', () => {
  test('renders the heatmap grid for the given weeks', () => {
    const weeks: HeatmapWeek[] = [[{ day: '2026-08-01', tokens: 5, level: 1 }, null, null, null, null, null, null]];
    const element = YearHeatmapBlock({
      weeks,
      labels: { title: 'Activity', less: 'Less', more: 'More' },
    });
    expect(element).toBeDefined();
  });
});
