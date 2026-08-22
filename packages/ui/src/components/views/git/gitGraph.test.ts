/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code's SCM history graph tests:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts

import { describe, expect, test } from 'bun:test';
import {
  buildGitHistoryViewModels,
  historyItemBaseRefColor,
  historyItemRefColor,
  historyItemRemoteRefColor,
  type GitHistoryItem,
  type GitHistoryRef,
} from './gitGraph';

function makeRef(
  id: string,
  name = id,
  revision?: string,
  category: GitHistoryRef['category'] = 'branches',
  kind: GitHistoryRef['kind'] = 'local',
): GitHistoryRef {
  return {
    id,
    name,
    revision: revision ?? null,
    category,
    kind,
  };
}

function makeItem(id: string, parentIds: string[], references?: GitHistoryRef[]): GitHistoryItem {
  return {
    id,
    parentIds,
    subject: '',
    message: '',
    author: '',
    authorEmail: '',
    timestamp: '',
    statistics: { files: 0, insertions: 0, deletions: 0 },
    references: references ?? [],
  };
}

describe('buildGitHistoryViewModels', () => {
  test('returns an empty graph for empty history', () => {
    expect(buildGitHistoryViewModels([], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    })).toEqual([]);
  });

  test('builds a linear history', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b']),
      makeItem('b', ['c']),
      makeItem('c', ['d']),
      makeItem('d', ['e']),
      makeItem('e', []),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels).toHaveLength(5);
    expect(viewModels[0].inputSwimlanes).toHaveLength(0);
    expect(viewModels[0].outputSwimlanes).toEqual([{ id: 'b', color: 'var(--chart-1)' }]);
    expect(viewModels[1].inputSwimlanes).toEqual([{ id: 'b', color: 'var(--chart-1)' }]);
    expect(viewModels[4].outputSwimlanes).toHaveLength(0);
  });

  test('keeps divergence and merge swimlanes stable', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b', 'c']),
      makeItem('c', ['d']),
      makeItem('b', ['e']),
      makeItem('e', ['f']),
      makeItem('f', ['d']),
      makeItem('d', ['g']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels[0].outputSwimlanes).toEqual([
      { id: 'b', color: 'var(--chart-1)' },
      { id: 'c', color: 'var(--chart-2)' },
    ]);
    expect(viewModels[1].inputSwimlanes).toEqual([
      { id: 'b', color: 'var(--chart-1)' },
      { id: 'c', color: 'var(--chart-2)' },
    ]);
    expect(viewModels[4].outputSwimlanes).toEqual([
      { id: 'd', color: 'var(--chart-1)' },
      { id: 'd', color: 'var(--chart-2)' },
    ]);
  });

  test('handles branches created from merge commits', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b', 'c']),
      makeItem('c', ['b']),
      makeItem('b', ['d', 'e']),
      makeItem('e', ['f']),
      makeItem('f', ['g']),
      makeItem('d', ['h']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels[2].inputSwimlanes).toEqual([
      { id: 'b', color: 'var(--chart-1)' },
      { id: 'b', color: 'var(--chart-2)' },
    ]);
    expect(viewModels[2].outputSwimlanes).toEqual([
      { id: 'd', color: 'var(--chart-1)' },
      { id: 'e', color: 'var(--chart-3)' },
    ]);
  });

  test('prioritizes current, upstream, and base ref colors and ordering', () => {
    const current = makeRef('refs/heads/topic', 'topic', 'a', 'branches', 'local');
    const upstream = makeRef('refs/remotes/origin/topic', 'origin/topic', 'c', 'remote-branches', 'remote');
    const base = makeRef('refs/remotes/origin/main', 'origin/main', 'g', 'remote-branches', 'remote');
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b'], [current]),
      makeItem('b', ['c']),
      makeItem('c', ['d'], [upstream]),
      makeItem('d', ['e']),
      makeItem('e', ['f', 'g']),
      makeItem('g', ['h'], [base]),
    ], { current, upstream, base }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels[0].outputSwimlanes[0].color).toBe(historyItemRefColor);
    expect(viewModels[2].outputSwimlanes[0].color).toBe(historyItemRemoteRefColor);
    expect(viewModels[4].outputSwimlanes[1].color).toBe(historyItemBaseRefColor);
    expect(viewModels[0].historyItem.references?.map((ref) => ref.id)).toEqual([current.id]);
    expect(viewModels[2].historyItem.references?.map((ref) => ref.id)).toEqual([upstream.id]);
  });

  test('adds incoming and outgoing synthetic nodes around the merge base', () => {
    const current = makeRef('refs/heads/main', 'main', 'c', 'branches', 'local');
    const upstream = makeRef('refs/remotes/origin/main', 'origin/main', 'a', 'remote-branches', 'remote');
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b'], [upstream]),
      makeItem('b', ['e']),
      makeItem('c', ['d'], [current]),
      makeItem('d', ['e']),
      makeItem('e', ['f']),
      makeItem('f', ['g']),
    ], { current, upstream, base: null }, {
      showIncoming: true,
      showOutgoing: true,
      mergeBase: 'e',
    });

    expect(viewModels.map((model) => model.kind)).toEqual([
      'node',
      'node',
      'outgoing-changes',
      'HEAD',
      'node',
      'incoming-changes',
      'node',
      'node',
    ]);
    expect(viewModels[2].outputSwimlanes).toEqual([
      { id: 'e', color: historyItemRemoteRefColor },
      { id: 'c', color: historyItemRefColor },
    ]);
    expect(viewModels[5].inputSwimlanes).toEqual([
      { id: 'scm-graph-incoming-changes', color: historyItemRemoteRefColor },
      { id: 'e', color: historyItemRefColor },
    ]);
  });

  test('skips the incoming synthetic node when incoming changes are already merged', () => {
    const current = makeRef('refs/heads/main', 'main', 'c', 'branches', 'local');
    const upstream = makeRef('refs/remotes/origin/main', 'origin/main', 'a', 'remote-branches', 'remote');
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b'], [upstream]),
      makeItem('b', ['c', 'd']),
      makeItem('c', ['e'], [current]),
      makeItem('d', ['e']),
      makeItem('e', ['f']),
      makeItem('f', ['g']),
    ], { current, upstream, base: null }, {
      showIncoming: true,
      showOutgoing: true,
      mergeBase: 'c',
    });

    expect(viewModels.some((model) => model.kind === 'incoming-changes')).toBe(false);
    expect(viewModels.find((model) => model.kind === 'HEAD')?.historyItem.id).toBe('c');
  });

  test('preserves unresolved parents on partial pages', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b', 'c']),
      makeItem('c', ['d']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels[0].outputSwimlanes).toEqual([
      { id: 'b', color: 'var(--chart-1)' },
      { id: 'c', color: 'var(--chart-2)' },
    ]);
    expect(viewModels[1].outputSwimlanes).toEqual([
      { id: 'b', color: 'var(--chart-1)' },
      { id: 'd', color: 'var(--chart-2)' },
    ]);
  });

  test('keeps existing swimlanes stable when additional history is appended', () => {
    const firstPage = buildGitHistoryViewModels([
      makeItem('a', ['b', 'c']),
      makeItem('c', ['d']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });
    const appended = buildGitHistoryViewModels([
      makeItem('a', ['b', 'c']),
      makeItem('c', ['d']),
      makeItem('b', ['e']),
      makeItem('e', ['f']),
      makeItem('d', ['g']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(appended[0].outputSwimlanes).toEqual(firstPage[0].outputSwimlanes);
    expect(appended[1].inputSwimlanes).toEqual(firstPage[1].inputSwimlanes);
    expect(appended[1].outputSwimlanes).toEqual(firstPage[1].outputSwimlanes);
  });
});
