import { describe, expect, test } from 'bun:test';

import { trackerContainerRows } from './containerTree';
import type { TrackerContainer } from './types';

const project: TrackerContainer = { id: 'p-1', key: 'PROJ', name: 'Project' };
const board: TrackerContainer = { id: 'b-1', key: null, name: 'Board', kind: 'board', parent: { id: 'p-1', key: 'PROJ', name: 'Project' } };
const sprint: TrackerContainer = { id: 's-1', key: null, name: 'Sprint 1', kind: 'sprint', parent: { id: 'b-1', key: null, name: 'Board' } };

describe('trackerContainerRows', () => {
  test('nests boards under their project and sprints under their board', () => {
    expect(trackerContainerRows([project, board, sprint])).toEqual([
      { container: project, depth: 0 },
      { container: board, depth: 1 },
      { container: sprint, depth: 2 },
    ]);
  });

  test('lists a parent before a child that came first', () => {
    expect(trackerContainerRows([sprint, board, project]).map(({ container, depth }) => [container.id, depth])).toEqual([
      ['p-1', 0],
      ['b-1', 1],
      ['s-1', 2],
    ]);
  });

  test('keeps containers without a kind, or whose parent is not listed, at the top level', () => {
    const loose: TrackerContainer = { id: 'x-1', key: null, name: 'Loose', kind: 'sprint', parent: { id: 'missing', key: null, name: 'Missing' } };
    expect(trackerContainerRows([project, loose]).map(({ container, depth }) => [container.id, depth])).toEqual([
      ['p-1', 0],
      ['x-1', 0],
    ]);
  });

  test('lists every container once when parents form a cycle', () => {
    const first: TrackerContainer = { id: 'a', key: null, name: 'A', parent: { id: 'b', key: null, name: 'B' } };
    const second: TrackerContainer = { id: 'b', key: null, name: 'B', parent: { id: 'a', key: null, name: 'A' } };
    expect(trackerContainerRows([first, second]).map(({ container }) => container.id)).toEqual(['a', 'b']);
  });
});
