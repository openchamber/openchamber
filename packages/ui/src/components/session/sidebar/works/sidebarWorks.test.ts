import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { buildSessionRootIndex, buildSidebarWorkIndex, buildWorktreeArchiveAnchors, isGroupWork, orderInWorkWorks, orderSidebarWorks, resolveWorkActivity } from './sidebarWorks';
import { pickWorkSessionToOpen } from './workActions';

// SAFETY: works read only ids, forks and metadata.
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: id, directory: '/repo', time: { created: 1, updated: 1 }, ...extra } as Session);
const node = (id: string, children: SessionNode[] = [], extra: Partial<Session> = {}): SessionNode => ({ session: session(id, extra), children, worktree: null });
const group = (id: string, sessions: SessionNode[], worktree: boolean): SessionGroup => ({
  id, label: id, branch: worktree ? id : null, description: null, isMain: !worktree, directory: `/${id}`,
  worktree: worktree ? { path: `/${id}`, projectDirectory: '/repo', branch: id, label: id } : null,
  sessions,
});

const section: ProjectSection = {
  project: { id: 'p', normalizedPath: '/repo' },
  groups: [
    group('main', [node('root', [node('review')]), node('lonely')], false),
    group('wt', [node('w1'), node('w2')], true),
    group('empty-wt', [], true),
  ],
};

describe('sidebar works', () => {
  test('a root session with what nests under it is one work, a worktree with all its sessions another', () => {
    const index = buildSidebarWorkIndex([section]);
    expect(index.bySessionId.get('review')?.key).toBe('session:root');
    expect(index.bySessionId.get('w2')?.key).toBe('p:wt');
    expect(index.groupWorks.map((ref) => ref.key)).toEqual(['p:wt', 'p:empty-wt']);
  });

  test('an isolated space is one work with every session in it, like a worktree', () => {
    const space: SessionGroup = {
      id: 'space:abc', label: 'quick-falcon', branch: null, description: null, isMain: false, directory: '/spaces/abc/repo', worktree: null,
      space: { id: 'abc', name: 'quick-falcon', state: 'complete', projectDirectory: '/repo', directory: '/spaces/abc/repo' },
      sessions: [node('s1', [node('s1-review')]), node('s2')],
    };
    const archive: SessionGroup = { ...group('archived', [node('gone')], false), isMain: false, isArchivedBucket: true };
    expect(isGroupWork(space)).toBe(true);
    expect(isGroupWork(archive)).toBe(false);
    const index = buildSidebarWorkIndex([{ ...section, groups: [...section.groups, space, archive] }]);
    expect(index.bySessionId.get('s1-review')?.key).toBe('p:space:abc');
    expect(index.bySessionId.get('s2')?.key).toBe('p:space:abc');
    expect(index.groupWorks.map((ref) => ref.key)).toEqual(['p:wt', 'p:empty-wt', 'p:space:abc']);
  });

  test('works come once each, in the order of their first matching session', () => {
    const index = buildSidebarWorkIndex([section]);
    const order = ['w2', 'review', 'w1', 'lonely', 'root'].map((id) => session(id));
    expect(orderSidebarWorks(order, index, (entry) => entry.id !== 'lonely').map((ref) => ref.key))
      .toEqual(['p:wt', 'session:root']);
  });

  describe('in work outside every added project', () => {
    const inWork = { metadata: { openchamber: { work: { state: 'open' } } } } as Partial<Session>;
    const outside = { directory: '/not-a-project' };
    // `promoted` has no parentID but nests under `outside-root` by lineage (a
    // promoted /btw or a review), so its work is its root's.
    const promoted = node('promoted', [], { ...outside, ...inWork });
    const subagent = node('subagent', [], { ...outside, ...inWork, parentID: 'outside-root' });
    const outsideRoot = node('outside-root', [promoted, subagent], outside);
    const childrenMap = new Map([['outside-root', [promoted.session, subagent.session]]]);
    const rootOf = buildSessionRootIndex([outsideRoot.session, session('root')], childrenMap);
    const notChat = () => false;

    test('every session maps to the top-level session it nests under', () => {
      expect(Object.fromEntries(rootOf)).toEqual({
        'outside-root': 'outside-root', promoted: 'outside-root', subagent: 'outside-root', root: 'root',
      });
    });

    test('a root in work without a registered project stays hidden', () => {
      const index = buildSidebarWorkIndex([section]);
      const tracked = session('tracked', { ...outside, ...inWork });
      const order = [session('w1', inWork), tracked, session('root', inWork)];
      const rootIndex = buildSessionRootIndex([tracked, session('root')], new Map());
      expect(orderInWorkWorks(order, index, rootIndex, notChat).map((ref) => ref.key))
        .toEqual(['p:wt', 'session:root']);
    });

    test('a nested session cannot admit a root without a registered project', () => {
      const index = buildSidebarWorkIndex([section]);
      const order = [promoted.session, subagent.session, outsideRoot.session];
      expect(orderInWorkWorks(order, index, rootOf, notChat).map((ref) => ({ key: ref.key, projectId: ref.projectId })))
        .toEqual([]);
    });
  });

  test('a worktree keeps the place its archived newest session gave it', () => {
    const index = buildSidebarWorkIndex([section]);
    // Listed newest first: lonely (30), w1 (20), root (10). The worktree's
    // newest session (25, archived) sat between lonely and w1.
    const values = new Map([['lonely', 30], ['archived', 25], ['w1', 20], ['root', 10], ['old', 5]]);
    const order = ['lonely', 'w1', 'root'].map((id) => session(id));
    const { anchors, archivedAt } = buildWorktreeArchiveAnchors({
      groupWorks: index.groupWorks,
      archivedSessions: [
        session('archived', { directory: '/wt' }),
        session('old', { directory: '/empty-wt' }),
        session('elsewhere', { directory: '/other' }),
      ],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
      isTopLevel: () => true,
    });
    expect([...anchors]).toEqual([['p:wt', 0.5], ['p:empty-wt', 2.5]]);
    expect(orderSidebarWorks(order, index, () => true, anchors).map((ref) => ref.key))
      .toEqual(['session:lonely', 'p:wt', 'session:root', 'p:empty-wt']);
    // The archived-only worktree keeps the time of the session that placed it, so the list by
    // time files it under that day; a listed worktree takes the newer of its two times.
    expect([...archivedAt]).toEqual([['p:wt', 25], ['p:empty-wt', 5]]);
    expect([...resolveWorkActivity({
      orderedSessions: order, index, include: () => true, orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: (entry) => entry.id === 'lonely', archivedAt,
    })]).toEqual([
      ['session:lonely', { kind: 'lead' }], ['p:wt', { kind: 'active', at: 25 }],
      ['session:root', { kind: 'active', at: 10 }], ['p:empty-wt', { kind: 'active', at: 5 }],
    ]);
  });

  test('worktrees whose archived sessions fall in one gap keep the order of those sessions in the list by time only', () => {
    const index = buildSidebarWorkIndex([section]);
    // Both worktrees' newest sessions are archived and newer than every listed one; the
    // worktree listed first in the project holds the older archived session.
    const values = new Map([['archived-old', 25], ['archived-new', 40], ['root', 10]]);
    const order = [session('root')];
    const { anchors, timelineAnchors } = buildWorktreeArchiveAnchors({
      groupWorks: index.groupWorks,
      archivedSessions: [session('archived-old', { directory: '/wt' }), session('archived-new', { directory: '/empty-wt' })],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
      isTopLevel: () => true,
    });
    expect(orderSidebarWorks(order, index, () => true, timelineAnchors).map((ref) => ref.key))
      .toEqual(['p:empty-wt', 'p:wt', 'session:root']);
    // Every other list keeps the project's order for worktrees sharing a gap.
    expect(orderSidebarWorks(order, index, () => true, anchors).map((ref) => ref.key))
      .toEqual(['p:wt', 'p:empty-wt', 'session:root']);
  });

  test('a subagent shown at the top level because its parent is gone places archived worktrees; one with a known parent does not', () => {
    const index = buildSidebarWorkIndex([section]);
    const values = new Map([['archived', 40], ['orphan', 30], ['kid', 20], ['root', 10]]);
    const order = [session('orphan', { parentID: 'gone' }), session('kid', { parentID: 'root' }), session('root')];
    const known = new Set(order.map((entry) => entry.id));
    const { anchors, timelineAnchors } = buildWorktreeArchiveAnchors({
      groupWorks: index.groupWorks,
      archivedSessions: [session('archived', { directory: '/wt' })],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
      isTopLevel: (entry) => !(entry.parentID && known.has(entry.parentID)),
    });
    // Only the list by time counts the orphan; By project and custom sections keep the gap above root.
    expect([...anchors]).toEqual([['p:wt', 1.5]]);
    expect([...timelineAnchors]).toEqual([['p:wt', -0.5]]);

    // Archived between the orphan and the nested kid: the kid is not a top-level row, so the
    // worktree goes in the gap above root.
    values.set('archived', 25);
    const between = buildWorktreeArchiveAnchors({
      groupWorks: index.groupWorks,
      archivedSessions: [session('archived', { directory: '/wt' })],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
      isTopLevel: (entry) => !(entry.parentID && known.has(entry.parentID)),
    });
    expect([...between.anchors]).toEqual([['p:wt', 1.5]]);
  });

  test('an orphan between two archived-only worktrees splits them in the list by time only', () => {
    const [main, ...worktrees] = section.groups;
    const index = buildSidebarWorkIndex([{
      ...section,
      groups: [{ ...main, sessions: [node('orphan', [], { parentID: 'gone' }), ...main.sessions] }, ...worktrees],
    }]);
    const values = new Map([['archived-new', 35], ['orphan', 30], ['archived-old', 25], ['root', 10]]);
    const order = [session('orphan', { parentID: 'gone' }), session('root')];
    const { anchors, timelineAnchors } = buildWorktreeArchiveAnchors({
      groupWorks: index.groupWorks,
      archivedSessions: [session('archived-old', { directory: '/wt' }), session('archived-new', { directory: '/empty-wt' })],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
      isTopLevel: (entry) => entry.id === 'orphan' || !entry.parentID,
    });
    // By project and custom time sections: both share the gap above root, in project order.
    expect(orderSidebarWorks(order, index, () => true, anchors).map((ref) => ref.key))
      .toEqual(['session:orphan', 'p:wt', 'p:empty-wt', 'session:root']);
    expect(orderSidebarWorks(order, index, () => true, timelineAnchors).map((ref) => ref.key))
      .toEqual(['p:empty-wt', 'session:orphan', 'p:wt', 'session:root']);
  });

  test('a click opens the latest session that is not a review or fork, else the latest, else nothing', () => {
    const review = node('review', [], { metadata: { openchamber: { kind: 'review', originalSessionID: 'x' } } });
    // SAFETY: only the fork's source id is read.
    const fork = node('fork', [], { fork: { sessionID: 'x' } as Session['fork'] });
    expect(pickWorkSessionToOpen([review, fork, node('work')])?.id).toBe('work');
    expect(pickWorkSessionToOpen([review, fork])?.id).toBe('review');
    expect(pickWorkSessionToOpen([])).toBeNull();
  });
});
