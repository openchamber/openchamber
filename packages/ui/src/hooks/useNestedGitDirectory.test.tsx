import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitStatus } from '@/lib/api/types';

const status = (unborn: boolean): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  unborn,
});

test('a root with no commits keeps its nested repositories reachable (#4886)', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  // Every git answer below is seeded into the store; a request would mean the
  // hook probed or scanned something it already knows.
  const requested: string[] = [];
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    requested.push(new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname);
    return new Promise<Response>(() => {});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { useNestedGitDirectory } = await import('./useNestedGitDirectory');

  const root = '/proj';
  const app = '/proj/app';
  // `unborn` null seeds a directory that is no repository.
  const seedDirectory = (directory: string, unborn: boolean | null) => {
    const directories = new Map(useGitStore.getState().directories);
    directories.set(directory, {
      isGitRepo: unborn !== null,
      status: unborn === null ? null : status(unborn),
      branches: null,
      log: null,
      identity: null,
      diffCache: new Map(),
      indexRevision: 0,
      lastRepoCheckAt: Date.now(),
      lastStatusFetch: Date.now(),
      lastStatusChange: 0,
      lastLogFetch: 0,
      lastBranchesFetch: 0,
      lastIdentityFetch: 0,
      logMaxCount: 25,
      isLoadingStatus: false,
      isLoadingLog: false,
      isLoadingBranches: false,
      isLoadingIdentity: false,
    });
    useGitStore.setState({ directories });
  };

  type Capture = { current: ReturnType<typeof useNestedGitDirectory> | null };
  const captured: Capture = { current: null };
  function Harness() {
    captured.current = useNestedGitDirectory(root);
    return null;
  }
  const current = () => {
    if (!captured.current) throw new Error('Hook did not render');
    return captured.current;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  const apis = createWebAPIs();
  const update = (change: () => void) => act(async () => { change(); });

  try {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    // `git init` at the root while `app` was the selected repository.
    seedDirectory(root, true);
    seedDirectory(app, false);
    useGitStore.setState({ nestedReposByRoot: new Map([[root, [app]]]) });
    useGitStore.getState().selectNestedRepo(root, app);

    await act(async () => {
      reactRoot.render(<RuntimeAPIContext.Provider value={apis}><Harness /></RuntimeAPIContext.Provider>);
    });
    expect(current().gitDirectory).toBe(app);
    expect(current().repositoryOptions).toEqual([root, app]);

    // Picking the root works on the root and is not undone by auto-select.
    await update(() => useGitStore.getState().selectNestedRepo(root, root));
    expect(useGitStore.getState().nestedRepoSelection.has(root)).toBe(false);
    expect(current().gitDirectory).toBe(root);
    expect(current().repositoryOptions).toEqual([root, app]);

    // And back to the nested repository.
    await update(() => useGitStore.getState().selectNestedRepo(root, app));
    expect(current().gitDirectory).toBe(app);

    // The first commit at the root makes it an ordinary repository again.
    await update(() => seedDirectory(root, false));
    expect(current().gitDirectory).toBe(root);
    expect(current().repositoryOptions).toBeNull();

    // A root that is no repository lists only what it found, as before.
    await update(() => seedDirectory(root, null));
    expect(current().gitDirectory).toBe(app);
    expect(current().repositoryOptions).toEqual([app]);

    // App bootstrap asks for the home folder on its own; no git reads happened.
    expect(requested.filter((path) => path !== '/api/fs/home')).toEqual([]);
  } finally {
    await act(async () => { reactRoot.unmount(); });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
