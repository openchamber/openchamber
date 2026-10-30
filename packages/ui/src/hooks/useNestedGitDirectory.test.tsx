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

test('a root repository offers its nested repositories and keeps its selection (#4886)', async () => {
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
  const lib = '/proj/app/lib';
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
    // A plain folder with a nested repository: it auto-selects the repository
    // because the root itself has nothing to show.
    seedDirectory(root, null);
    seedDirectory(app, false);
    useGitStore.setState({ nestedReposByRoot: new Map([[root, [app]], [app, [lib]]]) });

    await act(async () => {
      reactRoot.render(<RuntimeAPIContext.Provider value={apis}><Harness /></RuntimeAPIContext.Provider>);
    });
    expect(current().gitDirectory).toBe(app);
    expect(current().repositoryOptions).toEqual([app, lib]);
    // The pick was the hook's, not the user's: it is a guess.
    expect(useGitStore.getState().autoNestedRepoSelections.has(root)).toBe(true);

    // `git init` at the root while `app` was the selected repository. A root
    // with no commits hides nothing (#4886), so the guess still applies.
    await update(() => seedDirectory(root, true));
    expect(current().gitDirectory).toBe(app);
    expect(current().repositoryOptions).toEqual([root, app, lib]);

    // The first commit makes it an ordinary repository. The guess yields to
    // the root the user actually opened — it never outlives its reason — and
    // the root stays in the picker with the repositories under it.
    await update(() => seedDirectory(root, false));
    expect(current().gitDirectory).toBe(root);
    expect(current().repositoryOptions).toEqual([root, app]);
    expect(useGitStore.getState().nestedRepoSelection.has(root)).toBe(false);
    expect(useGitStore.getState().autoNestedRepoSelections.has(root)).toBe(false);

    // Picking a nested repository (a submodule, on disk) switches to it, and
    // this pick is the user's: it is not a guess and survives the root's own
    // commits.
    await update(() => useGitStore.getState().selectNestedRepo(root, app));
    expect(current().gitDirectory).toBe(app);
    expect(useGitStore.getState().autoNestedRepoSelections.has(root)).toBe(false);
    await update(() => seedDirectory(root, false));
    expect(current().gitDirectory).toBe(app);

    // The selected repository is a root of its own: what it contains joins the
    // picker one level down, next to the way back to the project root.
    expect(current().repositoryOptions).toEqual([root, app, lib]);
    await update(() => useGitStore.getState().selectNestedRepo(root, lib));
    expect(current().gitDirectory).toBe(lib);
    await update(() => useGitStore.getState().selectNestedRepo(root, app));
    expect(current().gitDirectory).toBe(app);

    // Picking the root switches back and removes the selection.
    await update(() => useGitStore.getState().selectNestedRepo(root, root));
    expect(useGitStore.getState().nestedRepoSelection.has(root)).toBe(false);
    expect(current().gitDirectory).toBe(root);
    expect(current().repositoryOptions).toEqual([root, app]);

    // A root that is no repository lists only what it found, as before.
    await update(() => seedDirectory(root, null));
    expect(current().gitDirectory).toBe(app);
    expect(current().repositoryOptions).toEqual([app, lib]);

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

test('opening a surface rescans the repositories under an established root', async () => {
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
  // A submodule added from a terminal leaves no event behind, so an opened
  // surface asks again instead of trusting the cached list.
  const requested: string[] = [];
  const scans: string[] = [];
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/api/fs/git-dirs') scans.push(url.searchParams.get('path') ?? '');
    requested.push(pathname);
    const body = pathname === '/api/fs/git-dirs' ? { repositories: [{ path: '/proj/app/lib' }] } : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { useNestedGitDirectory } = await import('./useNestedGitDirectory');

  const root = '/proj';
  const directories = new Map(useGitStore.getState().directories);
  directories.set(root, {
    isGitRepo: true,
    status: { ...status(false), current: 'main' },
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

  const captured: { current: ReturnType<typeof useNestedGitDirectory> | null } = { current: null };
  function Harness({ enabled = true }: { enabled?: boolean }) {
    captured.current = useNestedGitDirectory(root, { recheckOnOpen: true, enabled });
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);

  try {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    // A cached (empty) answer for an established root: the scan still runs.
    useGitStore.setState({ directories, nestedReposByRoot: new Map([[root, []]]) });

    await act(async () => {
      reactRoot.render(<RuntimeAPIContext.Provider value={createWebAPIs()}><Harness /></RuntimeAPIContext.Provider>);
    });
    await act(async () => { await Promise.resolve(); });

    expect(requested).toContain('/api/fs/git-dirs');

    for (const cached of [[], null] as const) {
      await act(async () => {
        reactRoot.render(<RuntimeAPIContext.Provider value={createWebAPIs()}><Harness enabled={false} /></RuntimeAPIContext.Provider>);
      });
      const selected = '/proj/app';
      const selectedDirectories = new Map(useGitStore.getState().directories);
      selectedDirectories.set(selected, { ...directories.get(root)!, diffCache: new Map() });
      await act(async () => {
        useGitStore.setState({ directories: selectedDirectories, nestedReposByRoot: new Map([[root, [selected]], [selected, cached === null ? null : []]]) });
        useGitStore.getState().selectNestedRepo(root, selected);
      });
      scans.length = 0;
      await act(async () => {
        reactRoot.render(<RuntimeAPIContext.Provider value={createWebAPIs()}><Harness /></RuntimeAPIContext.Provider>);
      });
      expect(scans.filter((path) => path === selected)).toEqual([selected]);
      expect(captured.current?.repositoryOptions).toContain('/proj/app/lib');
    }
  } finally {
    await act(async () => { reactRoot.unmount(); });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
