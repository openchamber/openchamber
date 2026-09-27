import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionTabsStore } from './useSessionTabsStore';

describe('useSessionTabsStore', () => {
  beforeEach(() => {
    useSessionTabsStore.setState({ tabIds: [] });
  });

  test('ensureTab appends once and preserves order', () => {
    const store = useSessionTabsStore.getState();
    store.ensureTab('a');
    store.ensureTab('b');
    store.ensureTab('a');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'b']);
  });

  test('lanes of one run share a tab: opening another lane reuses it in place', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'lane-1', 'b', 'lane-2'] });
    useSessionTabsStore.getState().ensureTab('lane-3', ['lane-1', 'lane-2', 'lane-3']);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'lane-3', 'b']);
    useSessionTabsStore.getState().ensureTab('c', []);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'lane-3', 'b', 'c']);
  });

  test('closeTab removes only the given id; closeOtherTabs keeps only it', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'] });
    useSessionTabsStore.getState().closeTab('b');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['a', 'c']);
    useSessionTabsStore.getState().closeOtherTabs('c');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['c']);
  });

  test('reorderTabs moves by id and ignores unknown ids', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'] });
    useSessionTabsStore.getState().reorderTabs('c', 'a');
    expect(useSessionTabsStore.getState().tabIds).toEqual(['c', 'a', 'b']);
    const before = useSessionTabsStore.getState().tabIds;
    useSessionTabsStore.getState().reorderTabs('x', 'a');
    expect(useSessionTabsStore.getState().tabIds).toBe(before);
  });

  test('caps the working set at 10, evicting the oldest tab', () => {
    useSessionTabsStore.setState({ tabIds: Array.from({ length: 10 }, (_, i) => `s${i}`) });
    useSessionTabsStore.getState().ensureTab('s-new');
    const ids = useSessionTabsStore.getState().tabIds;
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('s1');
    expect(ids.at(-1)).toBe('s-new');
  });

  test('removeTabs drops only confirmed-gone ids and no-ops otherwise', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'] });
    const before = useSessionTabsStore.getState().tabIds;
    useSessionTabsStore.getState().removeTabs(['x']);
    expect(useSessionTabsStore.getState().tabIds).toBe(before);
    useSessionTabsStore.getState().removeTabs(['a']);
    expect(useSessionTabsStore.getState().tabIds).toEqual(['b']);
  });
});
