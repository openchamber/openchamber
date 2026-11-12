import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import { countArchiveAllOutcome, selectArchiveAllSessionIds, withArchiveAllSubtrees } from './archiveAllSessions';

const session = (id: string, archived?: number): Session => ({
  id,
  projectID: 'p',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, archived },
});

const node = (value: Session, children: SessionNode[] = []): SessionNode => ({ session: value, children, worktree: null });

const group = (id: string, sessions: SessionNode[], isArchivedBucket = false): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'root',
  isArchivedBucket,
  worktree: null,
  directory: '/repo',
  sessions,
});

describe('selectArchiveAllSessionIds', () => {
  test('takes top-level sessions from every group and skips kept ones', () => {
    const groups = [
      group('root', [node(session('a'), [node(session('a-child'))]), node(session('pinned'))]),
      group('wt', [node(session('b')), node(session('running'))]),
    ];
    const kept = new Set(['pinned', 'running']);

    expect(selectArchiveAllSessionIds(groups, (s) => kept.has(s.id))).toEqual(['a', 'b']);
  });

  test('ignores the archived bucket and already archived sessions', () => {
    const groups = [
      group('root', [node(session('old', 5)), node(session('live'))]),
      group('archived', [node(session('gone', 9))], true),
    ];

    expect(selectArchiveAllSessionIds(groups, () => false)).toEqual(['live']);
  });
});

describe('withArchiveAllSubtrees', () => {
  const descendants = new Map([['a', ['a-child', 'a-grandchild']], ['b', ['b-child']], ['c', []]]);
  const descendantIdsOf = (id: string) => descendants.get(id) ?? [];

  test('takes each session with its subagents', () => {
    expect(withArchiveAllSubtrees(['a', 'c'], descendantIdsOf, () => false)).toEqual([
      { id: 'a', descendantIds: ['a-child', 'a-grandchild'] },
      { id: 'c', descendantIds: [] },
    ]);
  });

  test('keeps a session whose subagent is still running', () => {
    expect(withArchiveAllSubtrees(['a', 'b'], descendantIdsOf, (id) => id === 'a-grandchild'))
      .toEqual([{ id: 'b', descendantIds: ['b-child'] }]);
  });
});

describe('countArchiveAllOutcome', () => {
  const targets = [
    { id: 'a', descendantIds: ['a-child'] },
    { id: 'b', descendantIds: ['b-child'] },
    { id: 'c', descendantIds: [] },
  ];

  test('counts top-level sessions, failing one when any of its subagents failed', () => {
    expect(countArchiveAllOutcome(targets, [])).toEqual({ archived: 3, failed: 0 });
    expect(countArchiveAllOutcome(targets, ['a-child'])).toEqual({ archived: 2, failed: 1 });
    expect(countArchiveAllOutcome(targets, ['b', 'b-child', 'c'])).toEqual({ archived: 1, failed: 2 });
  });
});
