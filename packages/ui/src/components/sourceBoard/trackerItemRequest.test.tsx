import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { requestTrackerItemOpen } from '@/lib/trackerItemRequests';
import { TrackerItemRequests } from './trackerItemRequest';

test('a notification click opens its pull request once the app can tell where it belongs', async () => {
  const browser = new Window({ url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const originals = {
    registry: useSourceControlProviderRegistry.getState(), projects: useProjectsStore.getState(),
    directory: useDirectoryStore.getState(), board: useSourceBoardStore.getState(),
    ui: useUIStore.getState(), session: useSessionUIStore.getState(),
  };
  const external: string[] = [];
  browser.open = (url) => { external.push(String(url)); return null; };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const github = githubLikeDescriptor();
  const pull = 'https://github.com/acme/app/pull/7';
  try {
    useDirectoryStore.setState({ currentDirectory: '' });
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...originals.session.newSessionDraft, open: false } });
    useSourceControlProviderRegistry.setState({ ordered: [], byId: new Map(), status: 'loading', holdsList: false });
    useProjectsStore.setState({ projects: [], hasServerSnapshot: false, serverSnapshotFailed: false });
    await act(async () => root.render(React.createElement(TrackerItemRequests)));

    // The click started the app: neither the providers nor the projects are known yet.
    await act(async () => requestTrackerItemOpen({ url: pull, directory: '/work/app' }));
    expect(external).toEqual([]);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);

    await act(async () => useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true }));
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
    await act(async () => useProjectsStore.setState({ projects: [{ id: 'app', path: '/work/app' }], hasServerSnapshot: true }));
    expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
    expect(useSourceBoardStore.getState().repositoryFocus).toEqual({ kind: 'pull', query: pull });
    expect(external).toEqual([]);

    // Answered once: a later render does not open it again.
    useUIStore.getState().setSourceBoardOpen(false);
    await act(async () => useProjectsStore.setState({ projects: [{ id: 'app', path: '/work/app' }, { id: 'other', path: '/work/other' }] }));
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);

    // A pull request of a repository that belongs to no project here opens in the browser.
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/3', directory: '/somewhere/else' }));
    expect(external).toEqual(['https://github.com/elsewhere/lib/pull/3']);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);

    // After a service worker's click the worker opens the browser window, since the page may not.
    external.length = 0;
    const handedOff: string[] = [];
    const released: string[] = [];
    const handoff = (name: string) => ({ open: (url: string) => { handedOff.push(url); return true; }, release: () => { released.push(name); } });
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/4', directory: null }, handoff('elsewhere')));
    expect(handedOff).toEqual(['https://github.com/elsewhere/lib/pull/4']);
    expect(external).toEqual([]);
    await act(async () => requestTrackerItemOpen({ url: pull, directory: '/work/app' }, handoff('app')));
    expect(released).toEqual(['app']);
    expect(handedOff).toHaveLength(1);
    useUIStore.getState().setSourceBoardOpen(false);

    // The tab the click opened on the route goes to the pull request itself, since the browser
    // blocks a new window from it; the tab the user already had open never leaves the app.
    external.length = 0;
    const replaced: string[] = [];
    Object.defineProperty(browser.location, 'replace', { value: (url: string) => { replaced.push(url); }, configurable: true });
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/6', directory: null, loadedTab: true }));
    expect(replaced).toEqual(['https://github.com/elsewhere/lib/pull/6']);
    expect(external).toEqual([]);
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/8', directory: null }));
    expect(replaced).toHaveLength(1);
    expect(external).toEqual(['https://github.com/elsewhere/lib/pull/8']);
    await act(async () => requestTrackerItemOpen({ url: pull, directory: '/work/app', loadedTab: true }));
    expect(replaced).toHaveLength(1);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
    useUIStore.getState().setSourceBoardOpen(false);
    await act(async () => requestTrackerItemOpen({ url: 'https://evil.example/login', directory: '/work/app', loadedTab: true }));
    expect(replaced).toHaveLength(1);
    // A pull request path on a host no provider or connected account names goes nowhere at all.
    for (const directory of [null, '/work/app']) {
      await act(async () => requestTrackerItemOpen({ url: 'https://evil.example/a/b/pull/1', directory, loadedTab: true }));
    }
    expect(replaced).toHaveLength(1);
    expect(external).toEqual(['https://github.com/elsewhere/lib/pull/8']);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);

    // The phone app's WebView refuses a window no tap opened; a navigation goes to the system browser.
    external.length = 0;
    const assigned: string[] = [];
    let navigated: () => void = () => undefined;
    const navigation = new Promise<void>((resolve) => { navigated = resolve; });
    Object.defineProperty(browser.location, 'assign', { value: (url: string) => { assigned.push(url); navigated(); }, configurable: true });
    Object.defineProperty(browser, 'Capacitor', { value: { isNativePlatform: () => true }, configurable: true });
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/9', directory: '/nowhere' }));
    await navigation;
    expect(assigned).toEqual(['https://github.com/elsewhere/lib/pull/9']);
    expect(external).toEqual([]);
    await act(async () => requestTrackerItemOpen({ url: 'https://evil.example/a/b/pull/1', directory: null }));
    expect(assigned).toHaveLength(1);
    Reflect.deleteProperty(browser, 'Capacitor');

    // A crafted address that is no issue or pull request is dropped, never opened.
    external.length = 0;
    await act(async () => requestTrackerItemOpen({ url: 'https://evil.example/login', directory: '/work/app' }));
    await act(async () => requestTrackerItemOpen({ url: 'javascript:alert(1)', directory: '/work/app' }));
    expect(external).toEqual([]);
    expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useSourceControlProviderRegistry.setState(originals.registry, true);
    useProjectsStore.setState(originals.projects, true);
    useDirectoryStore.setState(originals.directory, true);
    useSourceBoardStore.setState(originals.board, true);
    useUIStore.setState(originals.ui, true);
    useSessionUIStore.setState(originals.session, true);
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a click that starts the app on a new chat opens the pull request beside that chat', async () => {
  const browser = new Window({ url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const originals = {
    registry: useSourceControlProviderRegistry.getState(), projects: useProjectsStore.getState(),
    directory: useDirectoryStore.getState(), ui: useUIStore.getState(), session: useSessionUIStore.getState(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const github = githubLikeDescriptor();
  const pull = 'https://github.com/acme/app/pull/7';
  const chat = '/data/chats/2026-11-26/session-1';
  let finishPreparing: () => void = () => undefined;
  try {
    useDirectoryStore.setState({ currentDirectory: '' });
    useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
    useProjectsStore.setState({ projects: [{ id: 'app', path: '/work/app' }], hasServerSnapshot: true });
    // The new chat on screen gets its own folder a moment later, as the side panel's MCP status asks.
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { ...originals.session.newSessionDraft, open: true, target: 'chat', preparedChatDirectory: null, bootstrapPendingDirectory: null, directoryOverride: null },
      prepareChatDraftDirectory: () => new Promise<string | null>((resolve) => {
        finishPreparing = () => {
          useSessionUIStore.setState((state) => ({ newSessionDraft: { ...state.newSessionDraft, preparedChatDirectory: chat } }));
          resolve(chat);
        };
      }),
    });
    await act(async () => root.render(React.createElement(TrackerItemRequests)));
    // An item for the browser does not wait for the chat's folder.
    const external: string[] = [];
    browser.open = (url) => { external.push(String(url)); return null; };
    await act(async () => requestTrackerItemOpen({ url: 'https://github.com/elsewhere/lib/pull/3', directory: '/nowhere' }));
    expect(external).toEqual(['https://github.com/elsewhere/lib/pull/3']);
    await act(async () => requestTrackerItemOpen({ url: pull, directory: '/work/app', loadedTab: true }));
    expect(Object.keys(useUIStore.getState().contextPanelByDirectory).filter((directory) => directory.includes('chats'))).toEqual([]);
    await act(async () => finishPreparing());
    const panel = useUIStore.getState().contextPanelByDirectory[chat];
    expect(panel?.tabs.some((tab) => tab.mode === 'pr' && tab.targetPath === pull)).toBe(true);
    expect(panel?.isOpen).toBe(true);
  } finally {
    await act(async () => root.unmount());
    useSourceControlProviderRegistry.setState(originals.registry, true);
    useProjectsStore.setState(originals.projects, true);
    useDirectoryStore.setState(originals.directory, true);
    useUIStore.setState(originals.ui, true);
    useSessionUIStore.setState(originals.session, true);
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
