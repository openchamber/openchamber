import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionMultiSelectStore } from './useSessionMultiSelectStore';

const selectedIds = (): string[] => [...useSessionMultiSelectStore.getState().selectedIds].sort();

beforeEach(() => {
  const initial = useSessionMultiSelectStore.getInitialState();
  useSessionMultiSelectStore.setState(initial, true);
});

describe('setRange ordered selection', () => {
  test('selects the inclusive slice between anchor and clicked row and keeps the anchor', () => {
    useSessionMultiSelectStore.getState().setRange('b', 'd', ['a', 'b', 'c', 'd', 'e'], 'project-a');

    const state = useSessionMultiSelectStore.getState();
    expect(selectedIds()).toEqual(['b', 'c', 'd']);
    expect(state.scopeKey).toBe('project-a');
    expect(state.anchorId).toBe('b');
  });

  test('selects backwards when the clicked row precedes the anchor', () => {
    useSessionMultiSelectStore.getState().setRange('d', 'b', ['a', 'b', 'c', 'd', 'e'], 'project-a');

    expect(selectedIds()).toEqual(['b', 'c', 'd']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('d');
  });

  test('anchors at the first ordered row when the stored anchor is not in the list', () => {
    useSessionMultiSelectStore.getState().setRange('removed-row', 'c', ['a', 'b', 'c', 'd'], 'project-a');

    expect(selectedIds()).toEqual(['a', 'b', 'c']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('a');
  });

  test('anchors at the first ordered row when no anchor is stored', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'b', ['a', 'b', 'c'], 'project-a');

    expect(selectedIds()).toEqual(['a', 'b']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('a');
  });

  test('ignores a range whose clicked row is not in the ordered list', () => {
    useSessionMultiSelectStore.getState().setRange('a', 'missing', ['a', 'b'], 'project-a');

    expect(selectedIds()).toEqual([]);
    expect(useSessionMultiSelectStore.getState().anchorId).toBeNull();
  });

  test('ignores a range with an empty ordered list', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'a', [], 'project-a');

    expect(selectedIds()).toEqual([]);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBeNull();
  });

  test('expands the clicked row descendants through the provided map', () => {
    const descendantsById = new Map([['c', ['c-child', 'c-grandchild']]]);
    useSessionMultiSelectStore.getState().setRange('a', 'c', ['a', 'b', 'c', 'd'], 'project-a', descendantsById);

    expect(selectedIds()).toEqual(['a', 'b', 'c', 'c-child', 'c-grandchild']);
  });

  test('replaces the selection when the scope changes', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('kept-other-project', 'project-a');
    store.setRange('a', 'b', ['a', 'b'], 'project-b');

    expect(selectedIds()).toEqual(['a', 'b']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-b');
  });

  test('unions with the existing selection inside the same scope', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('kept-same-project', 'project-a');
    store.setRange('a', 'b', ['a', 'b'], 'project-a');

    expect(selectedIds()).toEqual(['a', 'b', 'kept-same-project']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-a');
  });

  test('keeps duplicate ids in the ordered list as one selected row', () => {
    useSessionMultiSelectStore.getState().setRange('recent-copy', 'recent-copy', ['a', 'recent-copy', 'b', 'recent-copy'], 'project-a');

    expect(selectedIds()).toEqual(['recent-copy']);
  });
});
