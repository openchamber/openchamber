import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionMultiSelectStore } from './useSessionMultiSelectStore';

const selectedIds = (): string[] => [...useSessionMultiSelectStore.getState().selectedIds].sort();

const rows = (
  ids: readonly string[],
  scopeKey: string | null = 'project-a',
): { id: string; rowKey: string; scopeKey: string | null }[] => ids.map((id) => ({
  id,
  rowKey: `row:${id}`,
  scopeKey,
}));

beforeEach(() => {
  const initial = useSessionMultiSelectStore.getInitialState();
  useSessionMultiSelectStore.setState(initial, true);
});

describe('setRange ordered selection', () => {
  test('selects the inclusive slice between anchor and clicked row and keeps the anchor', () => {
    useSessionMultiSelectStore.getState().setRange('row:b', 'row:d', rows(['a', 'b', 'c', 'd', 'e']), 'project-a');

    const state = useSessionMultiSelectStore.getState();
    expect(selectedIds()).toEqual(['b', 'c', 'd']);
    expect(state.scopeKey).toBe('project-a');
    expect(state.anchorId).toBe('b');
    expect(state.anchorRowKey).toBe('row:b');
  });

  test('selects backwards when the clicked row precedes the anchor', () => {
    useSessionMultiSelectStore.getState().setRange('row:d', 'row:b', rows(['a', 'b', 'c', 'd', 'e']), 'project-a');

    expect(selectedIds()).toEqual(['b', 'c', 'd']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('d');
  });

  test('anchors at the first ordered row when the stored anchor is not in the list', () => {
    useSessionMultiSelectStore.getState().setRange('removed-row', 'row:c', rows(['a', 'b', 'c', 'd']), 'project-a');

    expect(selectedIds()).toEqual(['a', 'b', 'c']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('a');
  });

  test('anchors at the first ordered row when no anchor is stored', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'row:b', rows(['a', 'b', 'c']), 'project-a');

    expect(selectedIds()).toEqual(['a', 'b']);
    expect(useSessionMultiSelectStore.getState().anchorId).toBe('a');
  });

  test('ignores a range whose clicked row is not in the ordered list', () => {
    useSessionMultiSelectStore.getState().setRange('row:a', 'missing', rows(['a', 'b']), 'project-a');

    expect(selectedIds()).toEqual([]);
    expect(useSessionMultiSelectStore.getState().anchorId).toBeNull();
  });

  test('ignores a range with an empty ordered list', () => {
    useSessionMultiSelectStore.getState().setRange(null, 'row:a', [], 'project-a');

    expect(selectedIds()).toEqual([]);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBeNull();
  });

  test('expands the clicked row descendants through the provided map', () => {
    const descendantsById = new Map([['c', ['c-child', 'c-grandchild']]]);
    useSessionMultiSelectStore.getState().setRange('row:a', 'row:c', rows(['a', 'b', 'c', 'd']), 'project-a', descendantsById);

    expect(selectedIds()).toEqual(['a', 'b', 'c', 'c-child', 'c-grandchild']);
  });

  test('replaces the selection when the scope changes', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('kept-other-project', 'project-a');
    store.setRange('row:a', 'row:b', rows(['a', 'b'], 'project-b'), 'project-b');

    expect(selectedIds()).toEqual(['a', 'b']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-b');
  });

  test('unions with the existing selection inside the same scope', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('kept-same-project', 'project-a');
    store.setRange('row:a', 'row:b', rows(['a', 'b']), 'project-a');

    expect(selectedIds()).toEqual(['a', 'b', 'kept-same-project']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-a');
  });

  test('resolves duplicate occurrences by row key while keeping one API id', () => {
    const orderedRows = [
      { id: 'recent-copy', rowKey: 'recent:copy:first', scopeKey: 'project-a' },
      { id: 'other', rowKey: 'recent:copy:other', scopeKey: 'project-a' },
      { id: 'recent-copy', rowKey: 'recent:copy:second', scopeKey: 'project-a' },
    ];
    useSessionMultiSelectStore.getState().setRange(
      'recent:copy:first',
      'recent:copy:second',
      orderedRows,
      'project-a',
    );

    expect(selectedIds()).toEqual(['other', 'recent-copy']);
    expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe('recent:copy:first');
  });

  test('filters the range to the clicked scope before resolving a missing anchor', () => {
    const orderedRows = [
      { id: 'project-a-first', rowKey: 'project-a:first', scopeKey: 'project-a' },
      { id: 'project-a-last', rowKey: 'project-a:last', scopeKey: 'project-a' },
      { id: 'project-b-first', rowKey: 'project-b:first', scopeKey: 'project-b' },
      { id: 'project-b-last', rowKey: 'project-b:last', scopeKey: 'project-b' },
    ];

    useSessionMultiSelectStore.getState().setRange(
      'project-a:first',
      'project-b:last',
      orderedRows,
      'project-b',
    );

    expect(selectedIds()).toEqual(['project-b-first', 'project-b-last']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-b');
    expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe('project-b:first');
  });

  test('clears the row anchor when removing the anchored session', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('first', 'project-a', undefined, 'project-a:first');
    store.toggleSelected('second', 'project-a', undefined, 'project-a:second');

    store.removeMany(['second']);

    const state = useSessionMultiSelectStore.getState();
    expect(selectedIds()).toEqual(['first']);
    expect(state.anchorId).toBeNull();
    expect(state.anchorRowKey).toBeNull();
  });

  test('treats a null scope as distinct from a project scope', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('project-session', 'project-a', undefined, 'project:first');
    store.toggleSelected('directory-session', null, undefined, 'directory:first');

    const state = useSessionMultiSelectStore.getState();
    expect(selectedIds()).toEqual(['directory-session']);
    expect(state.scopeKey).toBeNull();
    expect(state.anchorRowKey).toBe('directory:first');
  });

  test('clears the occurrence anchor when replacing selection by API ids', () => {
    const store = useSessionMultiSelectStore.getState();
    store.toggleSelected('old', 'project-a', undefined, 'project-a:old');
    store.replaceAll(['new-a', 'new-b'], 'project-a');

    const state = useSessionMultiSelectStore.getState();
    expect(selectedIds()).toEqual(['new-a', 'new-b']);
    expect(state.anchorId).toBe('new-a');
    expect(state.anchorRowKey).toBeNull();
  });
});
