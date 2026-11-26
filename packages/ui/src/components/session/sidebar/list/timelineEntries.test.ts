import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import type { SessionSidebarWorkEntry } from '../sessionSidebarRowModel';
import { buildSidebarWorkIndex, type SidebarWorkRef } from '../works/sidebarWorks';
import { buildTimelineEntries } from './timelineEntries';

// SAFETY: the timeline reads only ids, directories and archive times.
const session = (id: string): Session => ({ id, title: id, directory: '/repo', time: { created: 1, updated: 1 } } as Session);
const node = (id: string): SessionNode => ({ session: session(id), children: [], worktree: null });
const worktree = (id: string, sessions: SessionNode[], pinnedAt?: number): SessionGroup => ({
  id, label: id, branch: id, description: null, isMain: false, directory: `/${id}`,
  worktree: { path: `/${id}`, projectDirectory: '/repo', branch: id, label: id, pinnedAt },
  sessions,
});
const space = (id: string): SessionGroup => ({
  id: `space:${id}`, label: id, branch: null, description: null, isMain: false, directory: `/spaces/${id}`, worktree: null,
  space: { id, name: id, state: 'complete', projectDirectory: '/repo', directory: `/spaces/${id}` },
  sessions: [],
});

const workIndex = buildSidebarWorkIndex([{
  project: { id: 'p', normalizedPath: '/repo' },
  groups: [
    { id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null, directory: '/repo', sessions: [node('pinned'), node('recent'), node('older')] },
    worktree('busy', [node('w1')]),
    worktree('kept', [], 5),
    worktree('fresh', []),
    space('live'),
  ],
}]);
const values = new Map([['pinned', 1], ['w1', 300], ['recent', 200], ['older', 100]]);
const orderedSessions = ['pinned', 'w1', 'recent', 'older'].map(session);
const toWorkEntries = (refs: readonly SidebarWorkRef[]): SessionSidebarWorkEntry[] => refs.map((ref) => (
  ref.kind === 'group'
    ? { kind: 'group', groupKey: ref.key, projectId: ref.projectId, group: ref.group }
    : { kind: 'session', item: { node: node(ref.rootSessionId), projectId: ref.projectId, groupDirectory: '/repo', secondaryMeta: null } }
));

describe('timeline entries', () => {
  test('pinned works, drafts and live spaces lead; worktrees without a session trail; the rest carry the time that ordered them', () => {
    const entries = buildTimelineEntries({
      orderedSessions,
      workIndex,
      archive: { anchors: new Map(), timelineAnchors: new Map(), archivedAt: new Map() },
      include: () => true,
      isExcluded: () => false,
      isLiveSpace: (ref) => ref.kind === 'group' && ref.group.space?.id === 'live',
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: (entry) => entry.id === 'pinned',
      rootDrafts: [{ draft: { id: 'd1', directory: '/repo', projectId: 'p', text: 'next', mentions: [], attachments: [], createdAt: 1, updatedAt: 1 }, projectId: 'p' }],
      toWorkEntries,
    });
    expect(entries.map((entry) => {
      const name = entry.kind === 'draft' ? `draft:${entry.draft.id}` : entry.kind === 'group' ? entry.group.label : entry.item.node.session.id;
      return `${name}:${entry.activity.kind === 'active' ? entry.activity.at : entry.activity.kind}`;
    })).toEqual([
      'draft:d1:lead', 'kept:lead', 'live:lead', 'pinned:lead',
      'busy:300', 'recent:200', 'older:100',
      'fresh:unstarted',
    ]);
  });
});
