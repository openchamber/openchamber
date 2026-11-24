import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { haveSameSidebarHierarchy, haveSameSidebarStructure } from './sidebarStructureKey';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_a',
  projectID: 'project',
  title: 'Parser fix',
  directory: '/repo',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  metadata: { openchamber: { work: { state: 'open', openedAt: 1, openedBy: 'auto' } } },
  ...overrides,
});

const same = (before: Session, after: Session, withActivityTime = false) => (
  haveSameSidebarStructure([before], [after], withActivityTime)
);

describe('haveSameSidebarStructure', () => {
  test('a finished turn changes only what a row shows', () => {
    const before = session();
    const after = session({
      time: { created: 1, updated: 9, idle: 9 },
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.2,
      outcome: 'failed',
      model: { providerID: 'perf', id: 'stream-300cps' },
      agent: 'plan',
      metadata: { openchamber: { work: { state: 'open', openedAt: 1, openedBy: 'auto' }, turn: { endedAt: 9, durationMs: 8 } } },
    });
    expect(same(before, after)).toBe(true);

    const bare = session({ metadata: undefined });
    expect(same(bare, session({ metadata: { openchamber: { turn: { endedAt: 9, durationMs: 8 } } } }))).toBe(true);
    expect(same(session({ metadata: { openchamber: {} } }), session({ metadata: { openchamber: { turn: { endedAt: 9, durationMs: 8 } } } }))).toBe(true);
    const work = { state: 'open', openedAt: 1 };
    expect(same(
      session({ metadata: { openchamber: { work }, other: 1 } }),
      session({ metadata: { openchamber: { work, turn: { endedAt: 9, durationMs: 8 } }, other: 1 } }),
    )).toBe(true);
  });

  test('membership, nesting, title, archive, work and pins change the structure', () => {
    const before = session();
    expect(same(before, session({ title: 'Renamed' }))).toBe(false);
    expect(same(before, session({ parentID: 'ses_parent' }))).toBe(false);
    expect(same(before, session({ directory: '/repo/worktree' }))).toBe(false);
    expect(same(before, session({ time: { created: 1, updated: 2, archived: 3 } }))).toBe(false);
    expect(same(before, session({ metadata: { openchamber: { work: { state: 'done', doneAt: 3 } } } }))).toBe(false);
    expect(same(before, session({ metadata: { openchamber: { work: { state: 'open' }, pinned: { at: 3 } } } }))).toBe(false);
    expect(haveSameSidebarStructure([before], [before, session({ id: 'ses_b' })], false)).toBe(false);
    expect(haveSameSidebarStructure([before, session({ id: 'ses_b' })], [session({ id: 'ses_b' }), before], false)).toBe(false);
  });

  test('the last activity time counts only where the sidebar reads it', () => {
    const before = session();
    const after = session({ time: { created: 1, updated: 9 } });
    expect(same(before, after, false)).toBe(true);
    expect(same(before, after, true)).toBe(false);
  });

  test('a turn ending after a done suggestion takes the suggestion back', () => {
    const suggested = { openchamber: { work: { state: 'open', suggestDoneAt: 5 } } };
    const before = session({ time: { created: 1, updated: 4, idle: 4 }, metadata: suggested });
    expect(same(before, session({ time: { created: 1, updated: 4, idle: 4 }, metadata: suggested }))).toBe(true);
    expect(same(before, session({ time: { created: 1, updated: 9, idle: 9 }, metadata: suggested }))).toBe(false);
  });
});

describe('haveSameSidebarHierarchy', () => {
  const hierarchy = (rootIds: string[], children: Array<[string, string[]]>) => ({
    activeSessionIds: [], activeRootIds: rootIds, activeChildrenByParentId: new Map(children), activeIdsByDirectory: new Map(),
  });

  test('a rebuilt hierarchy with the same nesting counts as the same', () => {
    expect(haveSameSidebarHierarchy(hierarchy(['a', 'b'], [['a', ['c']]]), hierarchy(['a', 'b'], [['a', ['c']]]))).toBe(true);
  });

  test('a moved, added or reordered session counts as a change', () => {
    const before = hierarchy(['a', 'b'], [['a', ['c']]]);
    expect(haveSameSidebarHierarchy(before, hierarchy(['a', 'b'], [['b', ['c']]]))).toBe(false);
    expect(haveSameSidebarHierarchy(before, hierarchy(['a', 'b', 'd'], [['a', ['c']]]))).toBe(false);
    expect(haveSameSidebarHierarchy(before, hierarchy(['b', 'a'], [['a', ['c']]]))).toBe(false);
    expect(haveSameSidebarHierarchy(before, hierarchy(['a', 'b'], [['a', ['c', 'e']]]))).toBe(false);
  });
});
