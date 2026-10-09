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

  test('selects an outside path only when allowOutsideRoot is set', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();

    store.setSelectedPath(root, '/tmp/agent-output.txt', { allowOutsideRoot: true });

    const state = useFilesViewTabsStore.getState().byRoot[root];
    expect(state?.selectedPath).toBe('/tmp/agent-output.txt');
    expect(state?.openPaths).toEqual(['/tmp/agent-output.txt']);
  });

  test('filters expanded path batches to the requested root', () => {
    const root = '/repo';

    useFilesViewTabsStore.getState().expandPaths(root, [
      '/repo/src',
      '/other/src',
    ]);

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual(['/repo/src']);
  });

  test('rejects realpath children of workspace symlinks (issue 2627)', () => {
    const root = '/workspace';
    const store = useFilesViewTabsStore.getState();

    store.toggleExpandedPath(root, '/workspace/pkg');
    store.toggleExpandedPath(root, '/real/pkg/src');
    store.toggleExpandedPath(root, '/workspace/pkg/src');

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual([
      '/workspace/pkg',
      '/workspace/pkg/src',
    ]);
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

  test('moves open, selected and expanded paths with a moved folder', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();
    store.addOpenPath(root, '/repo/src/a.ts');
    store.addOpenPath(root, '/repo/src/deep/b.ts');
    store.addOpenPath(root, '/repo/srcx/c.ts');
    store.setSelectedPath(root, '/repo/src/deep/b.ts');
    store.expandPaths(root, ['/repo/src', '/repo/src/deep', '/repo/srcx']);

    store.movePaths(root, '/repo/src', '/repo/lib/src');

    const state = useFilesViewTabsStore.getState().byRoot[root];
    expect(state?.openPaths).toEqual(['/repo/lib/src/a.ts', '/repo/lib/src/deep/b.ts', '/repo/srcx/c.ts']);
    expect(state?.selectedPath).toBe('/repo/lib/src/deep/b.ts');
    expect(state?.expandedPaths).toEqual(['/repo/lib/src', '/repo/lib/src/deep', '/repo/srcx']);
  });

  test('keeps the same state when a move touches none of its paths', () => {
    const root = '/repo';
    useFilesViewTabsStore.getState().addOpenPath(root, '/repo/a.ts');
    const before = useFilesViewTabsStore.getState().byRoot;

    useFilesViewTabsStore.getState().movePaths(root, '/repo/b.ts', '/repo/lib/b.ts');

    expect(useFilesViewTabsStore.getState().byRoot).toBe(before);
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
