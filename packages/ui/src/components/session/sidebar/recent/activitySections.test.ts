import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { deriveRecentActivitySections, deriveRecentSessions } from './activitySections';

const NOW = 200_000_000;
const RECENT = NOW - (48 * 60 * 60 * 1000);
const OLD = NOW - (72 * 60 * 60 * 1000);

const session = (id: string, options: { parentID?: string; archived?: number; updated?: number } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: { created: OLD, updated: options.updated ?? OLD, archived: options.archived },
} as Session);

describe('deriveRecentSessions', () => {
  test('includes an old root session while it is active', () => {
    const oldActive = session('old-active');

    expect(deriveRecentSessions([oldActive], new Set([oldActive.id]), NOW)).toEqual([oldActive]);
  });

  test('does not promote active children or archived sessions into Recent', () => {
    const child = session('child', { parentID: 'parent' });
    const archived = session('archived', { archived: NOW - 1 });

    expect(deriveRecentSessions(
      [child, archived],
      new Set([child.id, archived.id]),
      NOW,
    )).toEqual([]);
  });

  test('keeps inactive membership timestamp-based', () => {
    const oldSession = session('old');
    const recentSession = session('recent', { updated: RECENT });

    expect(deriveRecentSessions([oldSession, recentSession], new Set(), NOW)).toEqual([recentSession]);
  });
});

describe('deriveRecentActivitySections', () => {
  test('matches full IDs only, without falling back to titles or changing the matched subtree', () => {
    const target = { ...session('ses_f88b1a2b3c4d'), title: 'Release' };
    const other = { ...session('ses_f88b1a2b3c4e'), title: target.id };
    const node = { session: target, worktree: null, children: [{ session: other, worktree: null, children: [] }] };
    for (const query of [target.id, ` ${target.id.toUpperCase()} `, 'ses_f88b', 'ses_f88b1a2b3c4f']) {
      const sections = deriveRecentActivitySections({
        sessions: [target, other],
        getSessionLocation: () => null,
        getSessionNode: () => node,
        query,
      });
      const expected = query.trim().toLowerCase() === target.id ? [target.id] : [];
      expect(sections[0].items.map((item) => item.node.session.id)).toEqual(expected);
      for (const item of sections[0].items) expect(item.node).toBe(node);
    }
    expect(node.children).toHaveLength(1);
  });

  test('filters recent roots by search text and falls back to topology metadata', () => {
    const matching = {
      ...session('matching', { updated: RECENT }),
      title: 'Deploy release',
      directory: '/workspace/app/worktrees/release',
    };
    const excluded = {
      ...session('excluded', { updated: RECENT }),
      title: 'Investigate failure',
      directory: '/workspace/app',
    };

    const sections = deriveRecentActivitySections({
      sessions: [matching, excluded],
      getSessionLocation: (sessionId) => sessionId === matching.id ? {
        projectId: 'app',
        groupDirectory: '/workspace/app/worktrees/release',
        projectLabel: 'App',
        branchLabel: 'release',
      } : null,
      query: 'deploy',
    });

    expect(sections).toEqual([{
      key: 'active-now',
      items: [{
        node: { session: matching, children: [], worktree: null },
        projectId: 'app',
        groupDirectory: '/workspace/app/worktrees/release',
        secondaryMeta: { projectLabel: 'App', branchLabel: 'release' },
      }],
    }]);
  });
});
