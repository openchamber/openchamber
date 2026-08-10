import { describe, expect, test } from 'bun:test';
import { TopSessions } from './TopSessions';
import type { TopSessionEntry } from '@/lib/analytics/aggregate';

const entries: TopSessionEntry[] = [
  { id: 'ses_1', title: 'e8markets phase 11', tokens: 214_000_000, cost: 8.4, directory: '/repo/app', projectLabel: 'app', updatedAt: 1 },
];

describe('TopSessions', () => {
  test('renders a row per entry with title', () => {
    const element = TopSessions({
      entries,
      labels: { open: 'Open session', empty: 'No sessions' },
      onOpen: () => {},
    });
    expect(JSON.stringify(element)).toContain('e8markets phase 11');
  });

  test('renders the project label below the title', () => {
    const element = TopSessions({
      entries,
      labels: { open: 'Open session', empty: 'No sessions' },
      onOpen: () => {},
    });
    const json = JSON.stringify(element);
    expect(json).toContain('e8markets phase 11');
    expect(json).toContain('app');
  });

  test('omits the project label when null', () => {
    const element = TopSessions({
      entries: [{ ...entries[0]!, projectLabel: null }],
      labels: { open: 'Open session', empty: 'No sessions' },
      onOpen: () => {},
    });
    const json = JSON.stringify(element);
    expect(json).toContain('e8markets phase 11');
  });

  test('renders the empty state without entries', () => {
    const element = TopSessions({
      entries: [],
      labels: { open: 'Open session', empty: 'No sessions in range' },
      onOpen: () => {},
    });
    expect(JSON.stringify(element)).toContain('No sessions in range');
  });
});
