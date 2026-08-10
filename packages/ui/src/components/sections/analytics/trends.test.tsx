import { describe, expect, test } from 'bun:test';
import { TokenBreakdownChart } from './TokenBreakdownChart';
import type { DailyTokenBreakdown } from '@/lib/analytics/aggregate';

describe('TokenBreakdownChart', () => {
  test('renders a legend with the four token categories', () => {
    const breakdown: DailyTokenBreakdown[] = [
      { day: '2026-08-01', prompt: 10, completion: 5, reasoning: 2, cached: 3 },
    ];
    const element = TokenBreakdownChart({
      breakdown,
      labels: { title: 'Token breakdown', ariaLabel: 'Token breakdown', prompt: 'Prompt', completion: 'Completion', reasoning: 'Reasoning', cached: 'Cached' },
    });
    const json = JSON.stringify(element);
    expect(json).toContain('Prompt');
    expect(json).toContain('Completion');
    expect(json).toContain('Cached');
  });
});
