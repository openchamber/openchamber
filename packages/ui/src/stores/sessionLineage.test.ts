import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { createSessionLineage } from './sessionLineage';

const linked = (id: string, parentID: string | null, archived?: number): Session => {
  const time: Session['time'] = { created: 1, updated: 1 };
  if (archived) time.archived = archived;
  // SAFETY: the lineage reads only id, parentID, and time.archived.
  return { id, parentID, time } as Session;
};

const ids = (sessions: readonly Session[]): string[] => sessions.map((session) => session.id);

// root
// ├── a
// │   └── b
// ├── archived (archived)
// │   ├── under-archived
// │   └── archived-leaf (archived)
// └── c
const sessions = [
  linked('root', null),
  linked('a', 'root'),
  linked('b', 'a'),
  linked('archived', 'root', 5),
  linked('under-archived', 'archived'),
  linked('archived-leaf', 'archived', 6),
  linked('c', 'root'),
  linked('other', null),
];

describe('createSessionLineage', () => {
  const lineage = createSessionLineage(sessions);

  test('active stops at an archived session, parents before children', () => {
    expect(ids(lineage.descendantsOf('root', 'active'))).toEqual(['a', 'b', 'c']);
  });

  test('activeThroughArchived reaches active sessions below an archived intermediate', () => {
    expect(ids(lineage.descendantsOf('root', 'activeThroughArchived'))).toEqual(['a', 'b', 'under-archived', 'c']);
  });

  test('all takes archived sessions too', () => {
    expect(ids(lineage.descendantsOf('root', 'all'))).toEqual(['a', 'b', 'archived', 'under-archived', 'archived-leaf', 'c']);
  });

  test('archived stops at an active session', () => {
    expect(ids(lineage.descendantsOf('root', 'archived'))).toEqual(['archived', 'archived-leaf']);
  });

  test('a nested session resolves its own subtree only', () => {
    expect(ids(lineage.descendantsOf('a', 'active'))).toEqual(['b']);
    expect(lineage.descendantsOf('other', 'all')).toEqual([]);
  });

  test('a parent cycle ends instead of looping', () => {
    const cyclic = createSessionLineage([linked('x', 'y'), linked('y', 'x')]);
    expect(ids(cyclic.descendantsOf('x', 'all'))).toEqual(['y']);
  });

  test('archive and delete include reviews and their subagents but leave independent forks active', () => {
    const review = { ...linked('review', null), metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } } };
    const lineage = createSessionLineage([
      linked('root', null), review, linked('review-child', 'review'),
      { ...linked('fork', null), fork: { sessionID: 'root', boundary: { type: 'through', messageID: 'message' } } },
      { ...linked('promoted', null), fork: { sessionID: 'root', boundary: { type: 'through', messageID: 'message' } }, metadata: { openchamber: { btwPromoted: true } } },
    ]);
    expect(ids(lineage.descendantsOf('root', 'activeThroughArchived'))).toEqual(['review', 'review-child']);
    expect(ids(lineage.descendantsOf('root', 'all'))).toEqual(['review', 'review-child']);
    expect(lineage.descendantsOf('root', 'active')).toEqual([]);
  });

  test('restore includes archived reviews and their children, stopping at active reviews', () => {
    const review = (id: string, archived?: number) => ({
      ...linked(id, null, archived),
      metadata: { openchamber: { kind: 'review', originalSessionID: 'root' } },
    });
    const lineage = createSessionLineage([
      linked('root', null, 5), review('review', 5), linked('child', 'review', 5),
      review('active-review'), linked('other-child', 'active-review', 5),
      { ...linked('fork', null, 5), fork: { sessionID: 'root', boundary: { type: 'through', messageID: 'message' } } },
    ]);
    expect(ids(lineage.descendantsOf('root', 'archived'))).toEqual(['review', 'child']);
  });

  test('review metadata cycles terminate and parentID takes precedence', () => {
    const review = (id: string, originalSessionID: string, parentID: string | null = null) => ({
      ...linked(id, parentID), metadata: { openchamber: { kind: 'review', originalSessionID } },
    });
    const lineage = createSessionLineage([
      review('root', 'review'), review('review', 'root'), review('elsewhere', 'root', 'other'),
    ]);
    expect(ids(lineage.descendantsOf('root', 'all'))).toEqual(['review']);
  });
});
