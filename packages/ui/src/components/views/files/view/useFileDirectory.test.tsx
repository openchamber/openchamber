import React, { act } from 'react';
import { expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { DirectoryListResult } from '@/lib/api/types';

test('the phone tree lists only folders on screen, and nothing while an open file covers it', async () => {
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

  const { createRoot } = await import('react-dom/client');
  const { useFileDirectory } = await import('./useFileDirectory');
  const { createWebAPIs } = await import('../../../../../../web/src/api/index');

  const listed: string[] = [];
  const web = createWebAPIs();
  const files = {
    ...web.files,
    listDirectory: async (path: string): Promise<DirectoryListResult> => {
      listed.push(path);
      return { directory: path, entries: [] };
    },
  };
  const noop = () => {};
  const expandedPaths = ['/repo/a', '/repo/a/x', '/repo/b/y'];
  const scopeKey = JSON.stringify(['local', '/repo']);

  const Tree = ({ fileOpen }: { fileOpen: boolean }) => {
    const activeFileLoadIdRef = React.useRef(0);
    const loadingFilePathRef = React.useRef<string | null>(null);
    const treeScopeRef = React.useRef(scopeKey);
    useFileDirectory({
      fileDocument: { activeFileLoadIdRef, loadingFilePathRef, setDesktopImageSrc: noop, setFileContent: noop, setFileError: noop, setLoadedFilePath: noop },
      layout: { setShowMobilePageContent: noop, showMobilePageContent: fileOpen },
      scope: { fileScope: scopeKey, root: '/repo', showGitignored: true, showHidden: true, treeActive: true, treeScope: scopeKey, treeScopeRef },
      tabs: { expandedPaths, removeExpandedPathsByPrefix: noop },
      files,
    });
    return null;
  };

  jest.useFakeTimers();
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Tree fileOpen />));
    listed.length = 0;
    await act(async () => { jest.advanceTimersByTime(16_000); });
    expect(listed).toEqual([]);

    await act(async () => root.render(<Tree fileOpen={false} />));
    expect(listed.sort()).toEqual(['/repo/a', '/repo/a/x']);
  } finally {
    await act(async () => root.unmount());
    jest.useRealTimers();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
