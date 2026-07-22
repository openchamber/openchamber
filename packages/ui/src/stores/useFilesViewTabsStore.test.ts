import { beforeEach, describe, expect, test } from 'bun:test';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';

describe('useFilesViewTabsStore', () => {
  beforeEach(() => {
    useFilesViewTabsStore.setState({ byRoot: {}, activeRuntimeKey: 'runtime-a', runtimeSnapshots: {} });
  });

  test('ignores runtime paths outside the requested root', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, '/other/file.ts');
    store.setSelectedPath(root, '/other/file.ts');
    store.expandPath(root, '/other');
    store.toggleExpandedPath(root, '/other');

    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
  });

  test('filters expanded path batches to the requested root', () => {
    const root = '/repo';

    useFilesViewTabsStore.getState().expandPaths(root, [
      '/repo/src',
      '/other/src',
    ]);

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual(['/repo/src']);
  });

  test('removes stale expanded paths by prefix without closing files', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, '/repo/src/index.ts');
    store.expandPaths(root, [
      '/repo/src',
      '/repo/bun test packages',
      '/repo/bun test packages/web',
      '/repo/other',
    ]);

    store.removeExpandedPathsByPrefix(root, '/repo/bun test packages');

    const state = useFilesViewTabsStore.getState().byRoot[root];
    expect(state?.openPaths).toEqual(['/repo/src/index.ts']);
    expect(state?.expandedPaths).toEqual(['/repo/src', '/repo/other']);
  });

  test('restores independent active projections across runtime switches', () => {
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/a.ts');
    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/b.ts');

    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-a');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);
    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/b.ts']);
  });
});
