import { describe, expect, test } from 'bun:test';
import { RankedList } from './RankedList';

const items = [
  { id: 'a', title: 'Alpha session', values: ['45M'] },
  { id: 'b', title: 'Beta project', values: ['31M'] },
];

describe('RankedList', () => {
  test('renders ranked rows with dot colors and values', () => {
    const html = JSON.stringify(RankedList({ items, empty: 'none' }));
    expect(html).toContain('Alpha session');
    expect(html).toContain('45M');
    expect(html).toContain('--chart-1');
    expect(html).toContain('--chart-2');
  });
  test('empty state', () => {
    const html = JSON.stringify(RankedList({ items: [], empty: 'No entries' }));
    expect(html).toContain('No entries');
  });
  test('rows are buttons when onOpen is set', () => {
    const html = JSON.stringify(RankedList({ items, empty: 'none', onOpen: () => {}, openLabel: 'Open' }));
    expect(html).toContain('button');
    expect(html).toContain('Open: Alpha session');
  });
});
