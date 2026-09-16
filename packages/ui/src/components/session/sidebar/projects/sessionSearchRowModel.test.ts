import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GroupSearchData, SessionGroup, SessionNode } from '../types';
import { buildSessionSearchRowModel, type SessionSearchRowModelArgs } from './sessionSearchRowModel';

const PROJECT_ROOT = '/repo/project';
const WORKTREE_ROOT = '/repo/project-worktree';

const makeSession = (id: string, title = id, directory = PROJECT_ROOT): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title,
  version: '1',
  directory,
  time: { created: 1, updated: 1 },
});

const makeNode = (session: Session, children: SessionNode[] = []): SessionNode => ({
  session,
  children,
  worktree: null,
});

const makeGroup = (id: string, nodes: SessionNode[], overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'main',
  worktree: null,
  directory: PROJECT_ROOT,
  folderScopeKey: PROJECT_ROOT,
  sessions: nodes,
  ...overrides,
});

const makeProjectSection = (groups: SessionGroup[]) => ({
  project: { id: 'project', path: PROJECT_ROOT, normalizedPath: PROJECT_ROOT },
  groups,
});

const searchDataFor = (group: SessionGroup): WeakMap<SessionGroup, GroupSearchData> => new WeakMap([[group, {
  filteredNodes: group.sessions,
  matchedSessionCount: group.sessions.length,
  folderNameMatchCount: 0,
  groupMatches: false,
  hasMatch: true,
}]]);

const baseArgs = (): Omit<SessionSearchRowModelArgs, 'sections' | 'groupSearchDataByGroup' | 'chatGroup'> => ({
  foldersMap: {} satisfies SessionFoldersMap,
  normalizedQuery: 'release',
  collapsedProjects: new Set(),
  collapsedActivitySections: new Set(),
  showOnlyMainWorkspace: false,
  activeProjectId: null,
  singleProjectMode: false,
  singleProjectId: null,
  showRecentSection: false,
  recentSections: [],
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
  activeFolderScopesByOwner: new Map(),
});

describe('buildSessionSearchRowModel', () => {
  test('keeps every matched session in one ordered model without a result cap', () => {
    const nodes = Array.from({ length: 250 }, (_, index) => makeNode(makeSession(`ses_${index}`, `Release ${index}`)));
    const group = makeGroup('main', nodes);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: searchDataFor(group),
    });

    const sessionRows = model.rows.filter((row) => row.kind === 'session');
    expect(sessionRows).toHaveLength(250);
    expect(model.searchMatchCount).toBe(250);
    expect(model.entries.map((entry) => entry.id)).toEqual(
      nodes.map((node) => node.session.id).sort((left, right) => left.localeCompare(right)),
    );
    expect(model.rows.some((row) => row.kind === 'project-header')).toBe(true);
  });

  test('does not count an ancestor that is rendered only as exact-id search context', () => {
    const child = makeNode(makeSession('ses_child', 'Release child'));
    const parent = makeNode(makeSession('ses_parent', 'Unrelated parent'), [child]);
    const group = makeGroup('main', [parent]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      normalizedQuery: 'ses_child',
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [parent],
        matchedSessionCount: 1,
        folderNameMatchCount: 0,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual([
      'ses_parent',
      'ses_child',
    ]);
    expect(model.searchMatchCount).toBe(1);
  });

  test('counts a folder-name-only match in the header', () => {
    const group = makeGroup('main', []);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 1,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(0);
    expect(model.searchMatchCount).toBe(1);
  });

  test('counts a group-name-only match in the header', () => {
    const group = makeGroup('main', []);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 0,
        groupMatches: true,
        hasMatch: true,
      }]]),
    });

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(0);
    expect(model.searchMatchCount).toBe(1);
  });

  test('sums session, folder, and group matches of one group into the header count', () => {
    const nodes = [makeNode(makeSession('ses_a', 'Release a')), makeNode(makeSession('ses_b', 'Release b'))];
    const group = makeGroup('main', nodes);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: nodes,
        matchedSessionCount: 2,
        folderNameMatchCount: 3,
        groupMatches: true,
        hasMatch: true,
      }]]),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['ses_a', 'ses_b']);
    expect(model.searchMatchCount).toBe(6);
  });

  test('does not count folder names for an exact-id search', () => {
    const group = makeGroup('main', []);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      normalizedQuery: 'ses_target',
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [],
        matchedSessionCount: 0,
        // The data path forces folder matches to 0 for id queries; the model
        // count must still reflect exactly what the group contributes.
        folderNameMatchCount: 0,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    expect(model.searchMatchCount).toBe(0);
  });

  test('counts every rendered recent row, including exact-id matches only for ses_ queries', () => {
    const recentItem = {
      node: makeNode(makeSession('ses_recent', 'Release recent')),
      projectId: 'project',
      groupDirectory: PROJECT_ROOT,
      secondaryMeta: null,
    };
    const buildRecentModel = (normalizedQuery: string) => buildSessionSearchRowModel({
      ...baseArgs(),
      normalizedQuery,
      sections: [],
      chatGroup: null,
      showRecentSection: true,
      recentSections: [{ key: 'active-now', items: [recentItem] }],
      groupSearchDataByGroup: new WeakMap(),
    });

    expect(buildRecentModel('release').searchMatchCount).toBe(1);
    expect(buildRecentModel('ses_recent').searchMatchCount).toBe(1);
    expect(buildRecentModel('ses_other').searchMatchCount).toBe(0);
  });

  test('flattens folder subtrees before ungrouped sessions and preserves row-order entries', () => {
    const parent = makeNode(makeSession('ses_parent', 'Release parent'));
    const child = makeNode(makeSession('ses_child', 'Release child'));
    const ungrouped = makeNode(makeSession('ses_ungrouped', 'Release ungrouped'));
    const folder = { id: 'folder-parent', name: 'Parent', sessionIds: ['ses_parent'], createdAt: 1 };
    const childFolder = { id: 'folder-child', name: 'Child', parentId: 'folder-parent', sessionIds: ['ses_child'], createdAt: 2 };
    const group = makeGroup('main', [parent, child, ungrouped]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: { [PROJECT_ROOT]: [folder, childFolder] },
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.map((row) => row.kind === 'folder' ? row.displayName : row.kind === 'session' ? row.node.session.id : row.kind)).toEqual([
      'project-header',
      'Parent',
      'ses_parent',
      'Parent / Child',
      'ses_child',
      'ses_ungrouped',
    ]);
    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => row.displayName)).toEqual(['Parent', 'Parent / Child']);
    expect(model.entries.map((entry) => entry.id)).toEqual(['ses_parent', 'ses_child', 'ses_ungrouped']);
  });

  test('projects duplicate folder ids from every group scope without merging their trees', () => {
    const projectSession = makeNode(makeSession('ses_project', 'Release project', PROJECT_ROOT));
    const worktreeSession = makeNode(makeSession('ses_worktree', 'Release worktree', WORKTREE_ROOT));
    const group = makeGroup('main', [projectSession, worktreeSession], {
      folderScopeKey: PROJECT_ROOT,
      folderScopes: [
        { scopeKey: PROJECT_ROOT, directory: PROJECT_ROOT },
        { scopeKey: WORKTREE_ROOT, directory: WORKTREE_ROOT },
      ],
    });
    const sharedFolder = { id: 'shared-folder', name: 'Shared folder', sessionIds: ['ses_project'], createdAt: 1 };
    const worktreeFolder = { id: 'shared-folder', name: 'Shared folder', sessionIds: ['ses_worktree'], createdAt: 2 };
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: {
        [PROJECT_ROOT]: [sharedFolder],
        [WORKTREE_ROOT]: [worktreeFolder],
      },
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => ({
      scopeKey: row.scopeKey,
      folderId: row.folder.id,
      ownerKey: row.folderOwnerKey,
      nodeIds: row.nodes.map((node) => node.session.id),
    }))).toEqual([
      { scopeKey: PROJECT_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_project'] },
      { scopeKey: WORKTREE_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_worktree'] },
    ]);
    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['ses_project', 'ses_worktree']);
    expect(model.folderRows.map((row) => ({
      scopeKey: row.scopeKey,
      folderId: row.folder.id,
      ownerKey: row.folderOwnerKey,
      nodeIds: row.nodes.map((node) => node.session.id),
    }))).toEqual([
      { scopeKey: PROJECT_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_project'] },
      { scopeKey: WORKTREE_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_worktree'] },
    ]);
  });

  test('derives recent-row presence from visible recent sections', () => {
    const recentItem = {
      node: makeNode(makeSession('ses_recent', 'Release recent')),
      projectId: 'project',
      groupDirectory: PROJECT_ROOT,
      secondaryMeta: null,
    };
    const buildRecentModel = (collapsedActivitySections: ReadonlySet<'chats' | 'active-now'>, items = [recentItem]) => buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [],
      chatGroup: null,
      showRecentSection: true,
      recentSections: [{ key: 'active-now', items }],
      collapsedActivitySections,
      groupSearchDataByGroup: new WeakMap(),
    });

    expect(buildRecentModel(new Set()).hasRecentRows).toBe(true);
    expect(buildRecentModel(new Set(['active-now'])).hasRecentRows).toBe(false);
    expect(buildRecentModel(new Set(), []).hasRecentRows).toBe(false);
  });

  test('rebuilds folder rows when the folder map or search projection changes', () => {
    const node = makeNode(makeSession('ses_folder', 'Release folder session'));
    const group = makeGroup('main', [node]);
    const build = (foldersMap: SessionFoldersMap, filteredNodes: SessionNode[]) => buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes,
        matchedSessionCount: filteredNodes.length,
        folderNameMatchCount: 1,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });
    const initialModel = build({
      [PROJECT_ROOT]: [{ id: 'folder-a', name: 'Release plans', sessionIds: [node.session.id], createdAt: 1 }],
    }, [node]);
    const projectedModel = build({
      [PROJECT_ROOT]: [{ id: 'folder-a', name: 'Release plans', sessionIds: [node.session.id], createdAt: 1 }],
    }, []);
    const changedFoldersModel = build({
      [PROJECT_ROOT]: [{ id: 'folder-b', name: 'Release plans', sessionIds: [], createdAt: 2 }],
    }, []);

    expect(initialModel.folderRows.map((row) => row.folder.id)).toEqual(['folder-a']);
    expect(initialModel.folderRows[0]?.nodes.map((entry) => entry.session.id)).toEqual([node.session.id]);
    expect(projectedModel.folderRows.map((row) => row.folder.id)).toEqual(['folder-a']);
    expect(projectedModel.folderRows[0]?.nodes).toEqual([]);
    expect(projectedModel.folderRows).not.toBe(initialModel.folderRows);
    expect(changedFoldersModel.folderRows.map((row) => row.folder.id)).toEqual(['folder-b']);
    expect(changedFoldersModel.folderRows[0]?.nodes).toEqual([]);
  });

  test('keeps folder-only managed-chat matches from every chat scope', () => {
    const chatsRoot = '/home/user/chats';
    const datedChatsRoot = `${chatsRoot}/2026-09-13`;
    const chatGroup = makeGroup('managed-chats', [], {
      directory: chatsRoot,
      folderScopeKey: chatsRoot,
      folderScopes: [
        { scopeKey: chatsRoot, directory: chatsRoot },
        { scopeKey: datedChatsRoot, directory: datedChatsRoot },
      ],
      draftTarget: 'chat',
    });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      chatGroup,
      normalizedQuery: 'release',
      foldersMap: {
        [chatsRoot]: [{ id: 'shared-chat-folder', name: 'Release chats', sessionIds: [], createdAt: 1 }],
        [datedChatsRoot]: [{ id: 'shared-chat-folder', name: 'Release chats', sessionIds: [], createdAt: 2 }],
      },
      groupSearchDataByGroup: new WeakMap([[chatGroup, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 2,
        groupMatches: false,
        hasMatch: true,
      }]]),
      sections: [],
    });

    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => ({
      scopeKey: row.scopeKey,
      ownerKey: row.folderOwnerKey,
      folderId: row.folder.id,
    }))).toEqual([
      { scopeKey: chatsRoot, ownerKey: chatsRoot, folderId: 'shared-chat-folder' },
      { scopeKey: datedChatsRoot, ownerKey: chatsRoot, folderId: 'shared-chat-folder' },
    ]);
  });

  test('keeps managed-chat session rows on the shared owner scope', () => {
    const chatsRoot = '/home/user/chats';
    const datedDirectory = `${chatsRoot}/2026-09-13/session-chat`;
    const chat = makeNode(makeSession('ses_chat', 'Release chat', datedDirectory));
    const chatGroup = makeGroup('managed-chats', [chat], {
      directory: chatsRoot,
      folderScopeKey: chatsRoot,
      folderScopes: [{ scopeKey: chatsRoot, directory: chatsRoot }],
      draftTarget: 'chat',
    });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      chatGroup,
      sections: [],
      groupSearchDataByGroup: searchDataFor(chatGroup),
    });
    const sessionRow = model.rows.find((row): row is Extract<typeof row, { kind: 'session' }> => row.kind === 'session');

    expect(sessionRow?.selectionScopeKey).toBe(chatsRoot);
    expect(model.entries[0]?.scopeKey).toBe(chatsRoot);
  });

  test('keeps folder-only archived matches visible without matching session rows', () => {
    const group = makeGroup('archived', [], { isArchivedBucket: true });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: {
        [PROJECT_ROOT]: [{ id: 'archived-folder', name: 'Release archive', sessionIds: [], createdAt: 1 }],
      },
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 1,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    const folderRow = model.rows.find((row): row is Extract<typeof row, { kind: 'folder' }> => row.kind === 'folder');
    expect(folderRow?.folder.id).toBe('archived-folder');
    expect(folderRow?.archivedBucket).toBe(true);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(0);
  });

  test('prioritizes a canonically pinned archived session without active ordering', () => {
    const pinned = makeNode({
      ...makeSession('ses_pinned', 'Release pinned', `${PROJECT_ROOT}/`),
      time: { created: 1, updated: 1, archived: 2 },
    });
    const unpinned = makeNode({
      ...makeSession('ses_unpinned', 'Release unpinned'),
      time: { created: 1, updated: 1, archived: 2 },
    });
    const group = makeGroup('archived', [unpinned, pinned], {
      directory: null,
      folderScopeKey: `__archived__:${PROJECT_ROOT}`,
      isArchivedBucket: true,
    });
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), PROJECT_ROOT, pinned.session.id)!;
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      pinnedSessionIds: new Set([pinnedKey]),
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual([
      pinned.session.id,
      unpinned.session.id,
    ]);
  });

  test('orders unpinned archived sessions by newest lifecycle fallback', () => {
    const oldest = makeNode({
      ...makeSession('ses_oldest', 'Release oldest'),
      time: { created: 10, updated: 20, archived: 30 },
    });
    const newest = makeNode({
      ...makeSession('ses_newest', 'Release newest'),
      time: { created: 11, updated: 40, archived: 50 },
    });
    const group = makeGroup('archived', [oldest, newest], {
      directory: null,
      folderScopeKey: `__archived__:${PROJECT_ROOT}`,
      isArchivedBucket: true,
    });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual([
      newest.session.id,
      oldest.session.id,
    ]);
  });

  test('isolates duplicate session IDs by normalized directory and runtime', () => {
    const currentDirectory = makeNode(makeSession('ses_duplicate', 'Release current', `${PROJECT_ROOT}/`));
    const otherDirectory = makeNode(makeSession('ses_duplicate', 'Release other', `${PROJECT_ROOT}/other`));
    const group = makeGroup('archived', [otherDirectory, currentDirectory], {
      directory: null,
      folderScopeKey: `__archived__:${PROJECT_ROOT}`,
      isArchivedBucket: true,
    });
    const currentKey = getPinnedSessionKey(getRuntimeKey(), PROJECT_ROOT, currentDirectory.session.id)!;
    const currentDirectoryModel = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      pinnedSessionIds: new Set([currentKey]),
      groupSearchDataByGroup: searchDataFor(group),
    });
    const foreignRuntimeKey = getPinnedSessionKey('other-runtime', PROJECT_ROOT, currentDirectory.session.id)!;
    const foreignRuntimeModel = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      pinnedSessionIds: new Set([foreignRuntimeKey]),
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(currentDirectoryModel.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.directory)).toEqual([
      `${PROJECT_ROOT}/`,
      `${PROJECT_ROOT}/other`,
    ]);
    expect(foreignRuntimeModel.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.directory)).toEqual([
      `${PROJECT_ROOT}/other`,
      `${PROJECT_ROOT}/`,
    ]);
  });

  test('keeps active session order precedence ahead of pin priority', () => {
    const pinned = makeNode(makeSession('ses_pinned', 'Release pinned'));
    const earlier = makeNode(makeSession('ses_earlier', 'Release earlier'));
    const group = makeGroup('main', [pinned, earlier]);
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), PROJECT_ROOT, pinned.session.id)!;
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      pinnedSessionIds: new Set([pinnedKey]),
      sessionOrderIndex: new Map([[earlier.session.id, 0], [pinned.session.id, 1]]),
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual([
      earlier.session.id,
      pinned.session.id,
    ]);
  });

  test('orders chats and recent rows before project rows while keeping duplicate occurrences', () => {
    const chat = makeNode(makeSession('ses_chat', 'Release chat', '/home/user/chats'));
     const recent = makeNode(makeSession('ses_duplicate', 'Release recent'));
     const project = makeNode(makeSession('ses_duplicate', 'Release project'));
    const chatGroup = makeGroup('managed-chats', [chat], {
      isMain: true,
      directory: '/home/user/chats',
      folderScopeKey: '/home/user/chats',
      draftTarget: 'chat',
    });
    const projectGroup = makeGroup('main', [project]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([projectGroup])],
      chatGroup,
      groupSearchDataByGroup: new WeakMap([
        [chatGroup, { filteredNodes: [chat], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true }],
        [projectGroup, { filteredNodes: [project], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true }],
      ]),
      showRecentSection: true,
      recentSections: [{
        key: 'active-now',
        items: [{
          node: recent,
          projectId: 'project',
          groupDirectory: PROJECT_ROOT,
          secondaryMeta: null,
        }],
      }],
    });

    expect(model.rows.map((row) => row.kind === 'activity-header' ? row.activityKey : row.kind === 'session' ? row.node.session.id : row.kind)).toEqual([
      'chats',
      'ses_chat',
      'active-now',
      'ses_duplicate',
      'project-header',
      'ses_duplicate',
    ]);
    // Occurrences, not unique ids: the project row, the chat row, and the
    // Recent occurrence of the duplicated id each count.
    expect(model.searchMatchCount).toBe(3);
    expect(model.entries.map((entry) => entry.id)).toEqual(['ses_chat', 'ses_duplicate', 'ses_duplicate']);
    expect(model.entries[1]?.rowKey).not.toBe(model.entries[2]?.rowKey);
    expect(model.hasRecentRows).toBe(true);
  });
});
