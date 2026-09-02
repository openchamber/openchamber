import { describe, expect, test } from 'bun:test';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { normalizeFolderRoots, selectFolderIdsForProjection } from '../sessions/sessionNodeItemUtils';

const folder = (id: string, parentId: string | null = null, sessionIds: string[] = []): SessionFolder => ({
  id,
  name: id,
  parentId,
  sessionIds,
  createdAt: 1,
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
});

describe('selectFolderIdsForProjection', () => {
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

  test('keeps a fuzzy folder match and its ancestor', () => {
    const folders = [
      { id: 'root', name: 'Root', parentId: null, nodeCount: 0 },
      { id: 'child', name: 'Release Notes', parentId: 'root', nodeCount: 0 },
    ];

    expect([...selectFolderIdsForProjection(folders, { archivedBucket: false, searchQuery: 'release-notes' })])
      .toEqual(['root', 'child']);
  });
});
