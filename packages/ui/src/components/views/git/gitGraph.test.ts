/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code's SCM history graph tests:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts

import { describe, expect, test } from 'bun:test';
import {
  buildGitHistoryViewModels,
  getHistoryItemColumn,
  getHistoryItemMaxColumns,
  getHistoryItemSecondaryParentColumns,
  type GitHistoryGraphRef,
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

function buildCrissCrossViewModels() {
  return buildGitHistoryViewModels([
    makeItem('a37', ['594c', '3257']),
    makeItem('3257', ['2949']),
    makeItem('594c', ['base', '2949']),
    makeItem('2949', ['c55f']),
    makeItem('c55f', ['48f6']),
    makeItem('48f6', ['base']),
    makeItem('base', []),
  ], { current: null, upstream: null, base: null }, {
    showIncoming: false,
    showOutgoing: false,
    mergeBase: null,
  });
}

function expectedGraphColorFromIdentity(identity: string): string {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return `var(--git-graph-${(hash % 5) + 1})`;
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
    expect(viewModels[0].outputSwimlanes).toEqual([{ id: 'b', color: 'var(--git-graph-3)' }]);
    expect(viewModels[1].inputSwimlanes).toEqual([{ id: 'b', color: 'var(--git-graph-3)' }]);
    expect(viewModels[4].outputSwimlanes).toHaveLength(0);
  });

  test('assigns an unlabelled first parent from its FNV-1a commit identity instead of sequence position', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b']),
      makeItem('b', []),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(expectedGraphColorFromIdentity('b')).toBe('var(--git-graph-3)');
    expect(viewModels[0].outputSwimlanes).toEqual([{ id: 'b', color: 'var(--git-graph-3)' }]);
    expect(viewModels[1].nodeColor).toBe('var(--git-graph-3)');
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
      { id: 'b', color: 'var(--git-graph-3)' },
      { id: 'c', color: 'var(--git-graph-4)' },
    ]);
    expect(viewModels[1].inputSwimlanes).toEqual([
      { id: 'b', color: 'var(--git-graph-3)' },
      { id: 'c', color: 'var(--git-graph-4)' },
    ]);
    expect(viewModels[4].outputSwimlanes).toEqual([
      { id: 'd', color: 'var(--git-graph-3)' },
      { id: 'd', color: 'var(--git-graph-4)' },
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
      { id: 'b', color: 'var(--git-graph-3)' },
      { id: 'b', color: 'var(--git-graph-4)' },
    ]);
    expect(viewModels[2].outputSwimlanes).toEqual([
      { id: 'd', color: 'var(--git-graph-3)' },
      { id: 'e', color: 'var(--git-graph-5)' },
    ]);
  });

  test('keeps ref colors deterministic for non-tag refs while tags stay neutral', () => {
    const topic = makeRef('refs/heads/topic', 'topic', 'a', 'branches', 'local');
    const release = makeRef('refs/remotes/origin/release', 'origin/release', 'a', 'remote-branches', 'remote');
    const tag = makeRef('refs/tags/v1.0.0', 'v1.0.0', 'a', 'tags', 'tag');
    const items = [
      makeItem('a', ['b'], [topic, release, tag]),
      makeItem('b', []),
    ];
    const viewModels = buildGitHistoryViewModels(items, { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });
    const rebuilt = buildGitHistoryViewModels(items, { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(viewModels[0].historyItem.references?.map((ref) => ref.id)).toEqual([
      topic.id,
      release.id,
      tag.id,
    ]);
    expect(viewModels[0].historyItem.references?.map((ref: GitHistoryGraphRef) => ref.color)).toEqual(
      rebuilt[0].historyItem.references?.map((ref: GitHistoryGraphRef) => ref.color),
    );
    expect(/^var\(--git-graph-[1-5]\)$/.test(viewModels[0].historyItem.references?.[0]?.color ?? '')).toBe(true);
    expect(/^var\(--git-graph-[1-5]\)$/.test(viewModels[0].historyItem.references?.[1]?.color ?? '')).toBe(true);
    expect(viewModels[0].historyItem.references?.map((ref: GitHistoryGraphRef) => ref.color)).toEqual([
      viewModels[0].historyItem.references?.[0]?.color,
      viewModels[0].historyItem.references?.[1]?.color,
      undefined,
    ]);
  });

  test('keeps current and upstream ref identities on distinct graph slots', () => {
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

    expect(/^var\(--git-graph-[1-5]\)$/.test(viewModels[0].historyItem.references?.[0]?.color ?? '')).toBe(true);
    expect(/^var\(--git-graph-[1-5]\)$/.test(viewModels[2].historyItem.references?.[0]?.color ?? '')).toBe(true);
    expect(/^var\(--git-graph-[1-5]\)$/.test(viewModels[5].historyItem.references?.[0]?.color ?? '')).toBe(true);
    expect(viewModels[0].historyItem.references?.[0]?.color).not.toBe(viewModels[2].historyItem.references?.[0]?.color);
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
    const outgoingRefColor = viewModels.find((model) => model.historyItem.id === 'c')?.historyItem.references?.[0]?.color;
    const incomingRefColor = viewModels.find((model) => model.historyItem.id === 'a')?.historyItem.references?.[0]?.color;

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
    expect(/^var\(--git-graph-[1-5]\)$/.test(outgoingRefColor ?? '')).toBe(true);
    expect(/^var\(--git-graph-[1-5]\)$/.test(incomingRefColor ?? '')).toBe(true);
    expect(outgoingRefColor).not.toBe(incomingRefColor);
    expect(viewModels[2].outputSwimlanes).toEqual([
      { id: 'e', color: incomingRefColor! },
      { id: 'c', color: outgoingRefColor! },
    ]);
    expect(viewModels[5].inputSwimlanes).toEqual([
      { id: 'scm-graph-incoming-changes', color: incomingRefColor! },
      { id: 'e', color: outgoingRefColor! },
    ]);
    expect(viewModels[2].nodeColor).toBe(outgoingRefColor);
    expect(viewModels[5].nodeColor).toBe(incomingRefColor);
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
      { id: 'b', color: 'var(--git-graph-3)' },
      { id: 'c', color: 'var(--git-graph-4)' },
    ]);
    expect(viewModels[1].outputSwimlanes).toEqual([
      { id: 'b', color: 'var(--git-graph-3)' },
      { id: 'd', color: 'var(--git-graph-4)' },
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
    expect(appended.slice(0, firstPage.length).map((model) => model.nodeColor)).toEqual(
      firstPage.map((model) => model.nodeColor),
    );
  });

  test('matches VS Code criss-cross topology and resolves the duplicate parent on the last matching lane', () => {
    const viewModels = buildCrissCrossViewModels();
    const c3257 = viewModels.find((model) => model.historyItem.id === '3257')!;
    expect(getHistoryItemColumn(c3257)).toBe(1);

    expect(Math.max(...viewModels.map(getHistoryItemMaxColumns))).toBe(3);

    const merge = viewModels.find((model) => model.historyItem.id === '594c')!;
    expect(merge.outputSwimlanes.map((node) => node.id)).toEqual(['base', '2949', '2949']);
    expect(getHistoryItemSecondaryParentColumns(merge)).toEqual([2]);

    const duplicateParent = viewModels.find((model) => model.historyItem.id === '2949')!;
    expect(duplicateParent.inputSwimlanes.map((node) => node.id)).toEqual(['base', '2949', '2949']);
    expect(duplicateParent.outputSwimlanes.map((node) => node.id)).toEqual(['base', 'c55f']);
  });

  test('assigns stable theme color slots from ref and commit identities across rebuilds', () => {
    const current = makeRef('refs/heads/feature', 'feature', 'a');
    const upstream = makeRef('refs/remotes/upstream/main', 'upstream/main', 'c', 'remote-branches', 'remote');
    const items = [
      makeItem('a', ['b'], [current]),
      makeItem('b', ['c']),
      makeItem('c', [], [upstream]),
    ];
    const options = { showIncoming: false, showOutgoing: false, mergeBase: null };
    const first = buildGitHistoryViewModels(items, { current, upstream, base: null }, options);
    const rebuilt = buildGitHistoryViewModels(items, { current, upstream, base: null }, options);

    expect(first.map((model) => model.nodeColor)).toEqual(rebuilt.map((model) => model.nodeColor));
    expect(/^var\(--git-graph-[1-5]\)$/.test(first[0].nodeColor)).toBe(true);
    expect(/^var\(--git-graph-[1-5]\)$/.test(first[2].nodeColor)).toBe(true);
    expect(first[0].nodeColor).not.toBe(first[2].nodeColor);
  });

  test('avoids active-lane slot collisions while palette capacity remains', () => {
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['c', 'd']),
      makeItem('d', ['e']),
      makeItem('c', ['f']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(expectedGraphColorFromIdentity('c')).toBe('var(--git-graph-4)');
    expect(expectedGraphColorFromIdentity('d')).toBe('var(--git-graph-4)');
    expect(viewModels[0].outputSwimlanes[0]?.color).toBe('var(--git-graph-4)');
    expect(viewModels[0].outputSwimlanes[1]?.color).not.toBe('var(--git-graph-4)');
    expect(viewModels[0].outputSwimlanes[0]?.color).not.toBe(viewModels[0].outputSwimlanes[1]?.color);
  });

  test('assigns a deterministic graph slot to root commits', () => {
    const first = buildGitHistoryViewModels([
      makeItem('root', []),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });
    const rebuilt = buildGitHistoryViewModels([
      makeItem('root', []),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    expect(expectedGraphColorFromIdentity('root')).toBe('var(--git-graph-4)');
    expect(first[0].nodeColor).toBe('var(--git-graph-4)');
    expect(first[0].nodeColor).toBe(rebuilt[0].nodeColor);
  });

  test('probes labelled refs to different active-lane slots on identity collision', () => {
    const refA = makeRef('refs/heads/a', 'a');
    const refF = makeRef('refs/heads/f', 'f');
    const viewModels = buildGitHistoryViewModels([
      makeItem('a', ['b'], [refA]),
      makeItem('b', ['root']),
      makeItem('f', ['g'], [refF]),
      makeItem('g', ['root']),
    ], { current: null, upstream: null, base: null }, {
      showIncoming: false,
      showOutgoing: false,
      mergeBase: null,
    });

    const refAColor = viewModels[0].historyItem.references?.[0]?.color;
    const refFColor = viewModels[2].historyItem.references?.[0]?.color;

    expect(expectedGraphColorFromIdentity('refs/heads/a')).toBe('var(--git-graph-1)');
    expect(expectedGraphColorFromIdentity('refs/heads/f')).toBe('var(--git-graph-1)');
    expect(refAColor).toBe('var(--git-graph-1)');
    expect(refFColor).not.toBe('var(--git-graph-1)');
    expect(viewModels[2].outputSwimlanes).toHaveLength(2);
    expect(viewModels[2].outputSwimlanes[0]?.color).not.toBe(viewModels[2].outputSwimlanes[1]?.color);
    expect(viewModels[2].outputSwimlanes.find((lane) => lane.id === 'g')?.color).toBe(refFColor);
  });
});
