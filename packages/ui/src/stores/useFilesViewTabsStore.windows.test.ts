import { beforeEach, describe, expect, test } from 'bun:test';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';

describe('useFilesViewTabsStore Windows paths', () => {
  beforeEach(() => {
    useFilesViewTabsStore.setState({ byRoot: {} });
  });

  test('removes open paths by prefix case-insensitively for Windows drive paths', () => {
    const root = 'C:/Repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, 'C:/Repo/src/a.ts');
    store.addOpenPath(root, 'C:/Repo/other.ts');
    store.setSelectedPath(root, 'C:/Repo/src/a.ts');
    store.removeOpenPathsByPrefix(root, 'c:/repo/src');

    const rootState = useFilesViewTabsStore.getState().byRoot[root];
    expect(rootState?.openPaths).toEqual(['C:/Repo/other.ts']);
    expect(rootState?.selectedPath).toBe('C:/Repo/other.ts');
  });

  test('removes a single open path case-insensitively for Windows drive paths', () => {
    const root = 'C:/Repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, 'C:/Repo/src/a.ts');
    store.addOpenPath(root, 'C:/Repo/other.ts');
    store.setSelectedPath(root, 'C:/Repo/src/a.ts');
    store.removeOpenPath(root, 'c:/repo/src/a.ts');

    const rootState = useFilesViewTabsStore.getState().byRoot[root];
    expect(rootState?.openPaths).toEqual(['C:/Repo/other.ts']);
    expect(rootState?.selectedPath).toBe('C:/Repo/other.ts');
  });

  test('keeps the selected path when pruning it under a different drive-letter case', () => {
    const root = 'C:/Repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, 'C:/Repo/other.ts');
    store.setSelectedPath(root, 'C:/Repo/src/a.ts');
    store.removeUnselectedOpenPath(root, 'c:/repo/src/a.ts');

    const rootState = useFilesViewTabsStore.getState().byRoot[root];
    expect(rootState?.openPaths).toEqual(['C:/Repo/other.ts', 'C:/Repo/src/a.ts']);
    expect(rootState?.selectedPath).toBe('C:/Repo/src/a.ts');
  });

  for (const root of ['C:/', 'C:']) {
    test(`keeps tabs, selection and expansion under the drive root ${root} across a reload`, () => {
      const store = useFilesViewTabsStore.getState();

      store.addOpenPath(root, 'C:/Users/person/a.ts');
      store.setSelectedPath(root, 'C:/Users/person/a.ts');
      store.expandPath(root, 'C:/Users');

      const { partialize, merge } = useFilesViewTabsStore.persist.getOptions();
      const saved = JSON.parse(JSON.stringify(partialize?.(useFilesViewTabsStore.getState())));
      const restored = merge?.(saved, useFilesViewTabsStore.getInitialState()).byRoot['C:/'];
      expect(restored?.openPaths).toEqual(['C:/Users/person/a.ts']);
      expect(restored?.selectedPath).toBe('C:/Users/person/a.ts');
      expect(restored?.expandedPaths).toEqual(['C:/Users']);
    });
  }
});
