import { describe, expect, test } from 'bun:test';
import { filterSessionsForScope, resolveAnalyticsTab, type AnalyticsTab } from './AnalyticsPage';
import type { Session } from '@opencode-ai/sdk/v2';

const session = (id: string, directory: string): Session => ({
  id, slug: id, projectID: 'p', directory, title: id, version: '1',
  time: { created: 1, updated: 1 },
});

describe('filterSessionsForScope', () => {
  test('returns all sessions for the all scope', () => {
    const sessions = [session('a', '/x'), session('b', '/y')];
    expect(filterSessionsForScope(sessions, { kind: 'all' }, (s) => s.directory ?? null)).toHaveLength(2);
  });

  test('filters to the scope directory', () => {
    const sessions = [session('a', '/x'), session('b', '/y')];
    const result = filterSessionsForScope(
      sessions,
      { kind: 'directory', directory: '/x' },
      (s) => s.directory ?? null,
    );
    expect(result.map((s) => s.id)).toEqual(['a']);
  });
});

describe('resolveAnalyticsTab', () => {
  test('accepts overview and trends', () => {
    const overview: AnalyticsTab = resolveAnalyticsTab('overview');
    const trends: AnalyticsTab = resolveAnalyticsTab('trends');
    expect(overview).toBe('overview');
    expect(trends).toBe('trends');
  });
  test('falls back to overview for unknown input', () => {
    expect(resolveAnalyticsTab('garbage')).toBe('overview');
    expect(resolveAnalyticsTab('')).toBe('overview');
  });
});
