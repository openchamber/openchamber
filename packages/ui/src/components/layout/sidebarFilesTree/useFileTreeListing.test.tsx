import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { DirectoryListResult } from '@/lib/api/types';

for (const [directory, folder] of [['/', '/etc'], ['C:/', 'C:/Users']] as const) test(`a tree at the filesystem root ${directory} loads its expanded folders and relists them on refresh`, async () => {
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
  const { getAncestorPaths } = await import('@/components/views/files/view/fileViewPaths');
  const { normalizePath } = await import('./treePaths');
  const { useFileTreeListing } = await import('./useFileTreeListing');

  const listed: string[] = [];
  const web = createWebAPIs();
  const apis = {
    ...web,
    files: {
      ...web.files,
      listDirectory: async (path: string): Promise<DirectoryListResult> => {
        listed.push(path);
        return { directory: path, entries: [] };
      },
    },
  };
  useFilesViewTabsStore.setState({ byRoot: {} });
  useFilesViewTabsStore.getState().expandPaths(directory, getAncestorPaths(`${folder}/a.ts`, directory));

  let refresh = async () => {};
  const Tree = () => {
    const treeRoot = normalizePath(directory);
    const expandedPaths = useFilesViewTabsStore((state) => state.byRoot[treeRoot].expandedPaths);
    const { refreshRoot } = useFileTreeListing({ root: treeRoot, visible: true, showHidden: true, showGitignored: true, expandedPaths });
    React.useEffect(() => { refresh = refreshRoot; }, [refreshRoot]);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><Tree /></RuntimeAPIContext.Provider>));
    expect(listed.sort()).toEqual([directory, folder]);

    listed.length = 0;
    await act(async () => refresh());
    expect(listed).toEqual([directory, folder]);
  } finally {
    await act(async () => root.unmount());
    useFilesViewTabsStore.setState({ byRoot: {} });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
