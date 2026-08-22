import { describe, expect, test } from 'bun:test';
import { DailyBarsChart } from './DailyBarsChart';
import type { DailyBucket } from '@/lib/analytics/aggregate';

const daily: DailyBucket[] = [
  { day: '2026-08-07', tokens: 10, cost: 0.5, sessions: 3 },
  { day: '2026-08-08', tokens: 20, cost: 1.5, sessions: 7 },
];

describe('DailyBarsChart', () => {
  // BarChart/ScrollToEnd are function components — assert on the serialized
  // `data` prop values, not the rendered <title> strings.
  test('sessions metric uses the sessions field', () => {
    const html = JSON.stringify(DailyBarsChart({ daily, metric: 'sessions', ariaLabel: 's' }));
    expect(html).toContain('"value":7');
    expect(html).not.toContain('"value":1.5');
  });
  test('cost metric uses the cost field', () => {
    const html = JSON.stringify(DailyBarsChart({ daily, metric: 'cost', ariaLabel: 'c' }));
    expect(html).toContain('"value":1.5');
    expect(html).not.toContain('"value":7');
  });
});
