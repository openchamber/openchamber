import React, { act } from 'react';
import { expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { DirectoryListResult } from '@/lib/api/types';

type TreeRun = {
  listed: string[];
  refresh: () => Promise<void>;
  store: typeof import('@/stores/useFilesViewTabsStore').useFilesViewTabsStore;
};

const withTree = async (directory: string, expand: (run: Pick<TreeRun, 'store'>) => void, body: (run: TreeRun) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { useFilesViewTabsStore } = await import('@/stores/useFilesViewTabsStore');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { normalizePath } = await import('./treePaths');
  const { useFileTreeListing } = await import('./useFileTreeListing');

  const run: TreeRun = { listed: [], refresh: async () => {}, store: useFilesViewTabsStore };
  const web = createWebAPIs();
  const apis = {
    ...web,
    files: {
      ...web.files,
      listDirectory: async (path: string): Promise<DirectoryListResult> => {
        run.listed.push(path);
        return { directory: path, entries: [] };
      },
    },
  };
  useFilesViewTabsStore.setState({ byRoot: {} });
  expand(run);

  const Tree = () => {
    const treeRoot = normalizePath(directory);
    const expandedPaths = useFilesViewTabsStore((state) => state.byRoot[treeRoot].expandedPaths);
    const { refreshRoot } = useFileTreeListing({ root: treeRoot, visible: true, showHidden: true, showGitignored: true, expandedPaths });
    React.useEffect(() => { run.refresh = refreshRoot; }, [refreshRoot]);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><Tree /></RuntimeAPIContext.Provider>));
    await body(run);
  } finally {
    await act(async () => root.unmount());
    useFilesViewTabsStore.setState({ byRoot: {} });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

for (const [directory, folder] of [['/', '/etc'], ['C:/', 'C:/Users']] as const) test(`a tree at the filesystem root ${directory} loads its expanded folders and relists them on refresh`, async () => {
  const { getAncestorPaths } = await import('@/components/views/files/view/fileViewPaths');
  await withTree(directory, ({ store }) => store.getState().expandPaths(directory, getAncestorPaths(`${folder}/a.ts`, directory)), async (run) => {
    expect(run.listed.sort()).toEqual([directory, folder]);

    run.listed.length = 0;
    await act(async () => run.refresh());
    expect(run.listed).toEqual([directory, folder]);
  });
});

test('folders left expanded under a collapsed parent are listed only once the parent opens', async () => {
  await withTree('/repo', ({ store }) => store.getState().expandPaths('/repo', ['/repo/a', '/repo/a/x', '/repo/b/y', '/repo/b/y/z']), async (run) => {
    expect(run.listed.sort()).toEqual(['/repo', '/repo/a', '/repo/a/x']);

    run.listed.length = 0;
    await act(async () => run.refresh());
    expect(run.listed).toEqual(['/repo', '/repo/a', '/repo/a/x']);

    run.listed.length = 0;
    await act(async () => { run.store.getState().toggleExpandedPath('/repo', '/repo/b'); });
    expect(run.listed).toEqual(['/repo/b', '/repo/b/y', '/repo/b/y/z']);

    await act(async () => { run.store.getState().toggleExpandedPath('/repo', '/repo/b'); });
    await act(async () => run.refresh());
    run.listed.length = 0;
    const { notifyFileTreeChanged } = await import('@/lib/fileTreeChanges');
    jest.useFakeTimers();
    try {
      notifyFileTreeChanged({ directory: '/repo', paths: ['/repo/b/y/new.ts'] });
      await act(async () => { jest.advanceTimersByTime(2000); });
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
    expect(run.listed).toEqual([]);
  });
});
