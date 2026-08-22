import { describe, expect, test } from 'bun:test';
import { ChartCard } from './ChartCard';

describe('ChartCard', () => {
  test('renders title, aside and children', () => {
    const html = JSON.stringify(ChartCard({ title: 'Token breakdown', aside: 'Explore ›', children: 'BODY' }));
    expect(html).toContain('Token breakdown');
    expect(html).toContain('Explore ›');
    expect(html).toContain('BODY');
  });
});
