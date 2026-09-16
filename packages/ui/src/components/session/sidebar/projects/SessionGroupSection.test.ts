import { describe, expect, test } from 'bun:test';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionFolderIdentityKey } from '../sessions/sessionFolderIdentity';
import {
  normalizeFolderRoots,
  selectFolderIdsForProjection,
  selectSessionGroupVirtualizationMode,
} from '../sessions/sessionNodeItemUtils';
import {
  buildSessionGroupRenderRowModel,
  type SessionRowOrderFolderEntry,
} from '../sessions/sessionRowOrderUtils';
import type { SessionNode } from '../types';

const folder = (id: string, parentId: string | null = null, sessionIds: string[] = []): SessionFolder => ({
  id,
  name: id,
  parentId,
  sessionIds,
  createdAt: 1,
});

const sessionNode = (id: string): SessionNode => ({
  // SAFETY: virtualization threshold coverage only reads the fixture session id.
  session: { id } as Session,
  children: [],
  worktree: null,
});

describe('normalizeFolderRoots', () => {
  test('returns cycle and orphan folders as deterministic fallback roots without duplication', () => {
    const folders = [
      folder('cycle-a', 'cycle-b', ['session-a']),
      folder('cycle-b', 'cycle-a'),
      folder('orphan', 'missing-parent'),
      folder('root'),
    ];

    expect(normalizeFolderRoots(folders).map((entry) => entry.id))
      .toEqual(['orphan', 'root', 'cycle-a']);
  });

  test('keeps normal nested folder root order unchanged', () => {
    const folders = [folder('root-a'), folder('child-a', 'root-a'), folder('root-b')];

    expect(normalizeFolderRoots(folders).map((entry) => entry.id)).toEqual(['root-a', 'root-b']);
  });

  test('isolates duplicate folder ids across directory scopes', () => {
    const folders = [
      { ...folder('shared'), scopeKey: '/workspace' },
      { ...folder('shared'), scopeKey: '/workspace/worktree' },
      { ...folder('child', 'shared'), scopeKey: '/workspace/worktree' },
    ];

    expect(normalizeFolderRoots(folders).map((entry) => getSessionFolderIdentityKey(entry.scopeKey, entry.id)))
      .toEqual([
        getSessionFolderIdentityKey('/workspace', 'shared'),
        getSessionFolderIdentityKey('/workspace/worktree', 'shared'),
      ]);
  });
});

describe('selectFolderIdsForProjection', () => {
  test('ID queries retain folders containing results, not folders named after the ID', () => {
    const folders = [
      { id: 'root', name: 'Root', parentId: null, nodeCount: 0 },
      { id: 'child', name: 'Results', parentId: 'root', nodeCount: 1 },
      { id: 'unrelated', name: 'ses_f88b1a2b3c4d', parentId: null, nodeCount: 0 },
    ];
    expect([...selectFolderIdsForProjection(folders, { archivedBucket: false, searchQuery: ' SES_F88B1A2B3C4D ' })])
      .toEqual(['root', 'child']);
  });

  const malformedFolders = [
    { id: 'cycle-a', name: 'cycle-a', parentId: 'cycle-b', nodeCount: 0 },
    { id: 'cycle-b', name: 'cycle-b', parentId: 'cycle-a', nodeCount: 1 },
    { id: 'orphan', name: 'orphan', parentId: 'missing-parent', nodeCount: 0 },
  ];

  test('keeps malformed empty and nonempty folders in every projection mode', () => {
    for (const archivedBucket of [false, true]) {
      for (const searchQuery of ['', 'does-not-match']) {
        expect([...selectFolderIdsForProjection(malformedFolders, { archivedBucket, searchQuery })])
          .toEqual(['cycle-a', 'cycle-b', 'orphan']);
      }
    }
  });

  test('keeps normal archived/search nesting semantics', () => {
    const folders = [
      { id: 'root', name: 'root', parentId: null, nodeCount: 0 },
      { id: 'child', name: 'matching-child', parentId: 'root', nodeCount: 1 },
    ];

    expect([...selectFolderIdsForProjection(folders, { archivedBucket: true, searchQuery: 'matching' })])
      .toEqual(['root', 'child']);
  });

  test('keeps an archived folder-name match even when no matching session is projected', () => {
    const folders = [{ id: 'archive', name: 'Release archive', parentId: null, nodeCount: 0 }];

    expect([...selectFolderIdsForProjection(folders, { archivedBucket: true, searchQuery: 'release' })])
      .toEqual(['archive']);
  });

  test('keeps a fuzzy folder match and its ancestor', () => {
    const folders = [
      { id: 'root', name: 'Root', parentId: null, nodeCount: 0 },
      { id: 'child', name: 'Release Notes', parentId: 'root', nodeCount: 0 },
    ];

    expect([...selectFolderIdsForProjection(folders, { archivedBucket: false, searchQuery: 'release-notes' })])
      .toEqual(['root', 'child']);
  });

  test('does not let a matching subtree in one scope project a same-id folder in another', () => {
    const worktreeRoot = getSessionFolderIdentityKey('/workspace/worktree', 'shared');
    const worktreeChild = getSessionFolderIdentityKey('/workspace/worktree', 'release');
    const folders = [
      { id: 'shared', name: 'Unrelated', parentId: null, nodeCount: 0, scopeKey: '/workspace' },
      { id: 'shared', name: 'Worktree root', parentId: null, nodeCount: 0, scopeKey: '/workspace/worktree' },
      { id: 'release', name: 'Release notes', parentId: 'shared', nodeCount: 1, scopeKey: '/workspace/worktree' },
    ];

    expect([...selectFolderIdsForProjection(folders, { archivedBucket: false, searchQuery: 'release-notes' })])
      .toEqual([worktreeRoot, worktreeChild]);
  });
});

describe('archived group virtualization threshold', () => {
  const renderableArchivedRowCount = (sessionCount: number): number => {
    const entry: SessionRowOrderFolderEntry = {
      folder: { id: 'archive', name: 'Archive', parentId: null },
      scopeKey: '/workspace',
      scopeDirectory: '/workspace',
      nodes: Array.from({ length: sessionCount }, (_, index) => sessionNode(`session-${index}`)),
    };
    return buildSessionGroupRenderRowModel({
      groupKey: 'project:archive',
      isCollapsed: false,
      hasSessionSearchQuery: false,
      collapsedFolderIds: new Set(),
      expandedParents: new Set(),
      archivedBucket: true,
      projectId: 'project',
      groupDirectory: '/workspace',
      rootFolders: [entry],
      childFoldersByParentId: new Map(),
      visibleSessions: [],
    }).rows.length;
  };

  test('uses the complete flattened folder model at threshold -1, threshold, and +1', () => {
    const renderableCounts = [48, 49, 50].map(renderableArchivedRowCount);
    const modes = renderableCounts.map((rootCount) => selectSessionGroupVirtualizationMode({
      isArchivedBucket: true,
      rootCount,
    }));

    expect(renderableCounts).toEqual([49, 50, 51]);
    expect(modes).toEqual(['none', 'roots', 'roots']);
  });
});
