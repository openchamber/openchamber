import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildSidebarWorkFacts, EMPTY_SIDEBAR_LIVE_FACTS } from './workFacts';
import { buildSidebarWorkIndex, findWorkFolderId } from '../works/sidebarWorks';
import type { SessionGroup } from '../types';

const session = (metadata: Session['metadata']): Session => ({
  id: 's1', projectID: 'p', directory: '/p', title: 'Nightly triage', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 }, metadata,
});

const factsFor = (record: Session) => buildSidebarWorkFacts(
  { kind: 'session', key: 'session:s1', projectId: 'p', rootSessionId: 's1' },
  { sessionById: new Map([['s1', record]]), childrenMap: new Map(), runKeyBySessionId: new Map(), live: EMPTY_SIDEBAR_LIVE_FACTS, planSessionIds: new Set(), folderByMember: new Map([['s1', { folderId: 'folder', projectId: 'p' }]]) },
);

describe('buildSidebarWorkFacts', () => {
  test('session display inherits a worktree folder and named pin list', () => {
    const record = session({});
    const group: SessionGroup = {
      id: 'wt', label: 'topic', branch: 'topic', description: null, isMain: false, directory: '/wt',
      worktree: { path: '/wt', projectDirectory: '/p', branch: 'topic', label: 'topic', pinnedAt: 10, pinList: 'named' },
      sessions: [{ session: record, children: [], worktree: null }],
    };
    const index = buildSidebarWorkIndex([{ project: { id: 'p', normalizedPath: '/p' }, groups: [group] }], true);
    const ref = index.bySessionId.get('s1');
    if (!ref) throw new Error('Expected projected session');
    const folderByMember = new Map([['worktree:/wt', { folderId: 'work-folder', projectId: 'p' }]]);
    expect(findWorkFolderId(ref, folderByMember)).toBe('work-folder');
    const facts = buildSidebarWorkFacts(ref, {
      sessionById: new Map([['s1', record]]), childrenMap: new Map(), runKeyBySessionId: new Map(),
      live: EMPTY_SIDEBAR_LIVE_FACTS, planSessionIds: new Set(), folderByMember,
    });
    expect(facts).toMatchObject({ kind: 'session', pin: 'named', folderId: 'work-folder' });
    folderByMember.set('s1', { folderId: 'own-folder', projectId: 'p' });
    expect(findWorkFolderId(ref, folderByMember)).toBe('own-folder');
  });
  test('a session names the folder holding it', () => {
    expect(factsFor(session({})).folderId).toBe('folder');
  });
  test('an explicit session pin list takes precedence over its projected worktree pin', () => {
    const record = session({ openchamber: { pinned: { at: 1, list: 'reviews' } } });
    const originGroup: SessionGroup = {
      id: 'wt', label: 'topic', branch: 'topic', description: null, isMain: false, directory: '/wt',
      worktree: { path: '/wt', projectDirectory: '/p', branch: 'topic', label: 'topic', pinnedAt: 10 },
      sessions: [{ session: record, children: [], worktree: null }],
    };
    expect(buildSidebarWorkFacts(
      { kind: 'session', key: 'session:s1', projectId: 'p', rootSessionId: 's1', originGroup },
      { sessionById: new Map([['s1', record]]), childrenMap: new Map(), runKeyBySessionId: new Map(), live: EMPTY_SIDEBAR_LIVE_FACTS, planSessionIds: new Set(), folderByMember: new Map() },
    ).pin).toBe('reviews');
  });

  test('a session updated into a new record is read again', () => {
    const before = session({ openchamber: { kind: 'scheduled' } });
    expect(factsFor(before)).toMatchObject({ scheduled: true, inWork: false });
    expect(factsFor(before)).toMatchObject({ scheduled: true, inWork: false });
    const after = session({ openchamber: { kind: 'scheduled', work: { state: 'open', at: 3 } } });
    expect(factsFor(after)).toMatchObject({ scheduled: true, inWork: true });
  });
});
