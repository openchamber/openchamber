import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator,
  Event: browser.Event, CustomEvent: browser.CustomEvent,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  ShadowRoot: browser.ShadowRoot, DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.assign(globalThis, globals);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ home: '/home', chatsRoot: '/chats', items: [], directory: '/project', project: { directory: '/project' }, data: [], revision: 0, enabled: false, minutes: 5, sessions: [] });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../web/src/api');
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useServerBrowserAgentTab } = await import('@/lib/browser/serverBrowser/panelTabs');
const { ContextPanel } = await import('./ContextPanel');
const sdk = OpenCode.make({ baseUrl: 'http://context.test', fetch: () => new Promise<Response>(() => undefined) });
const apis = createWebAPIs();

afterAll(() => {
  globalThis.fetch = originalFetch;
  browser.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('browser tabs follow the server browser agent marker when its tab changes', async () => {
  // Given
  const initialUI = useUIStore.getState();
  const initialDirectory = useDirectoryStore.getState();
  const initialAgent = useServerBrowserAgentTab.getState();
  useDirectoryStore.setState({ currentDirectory: '/project' });
  useUIStore.getState().openContextBrowser('/project', 'https://first.example/');
  useUIStore.getState().openContextBrowser('/project', 'https://second.example/');
  const tabs = useUIStore.getState().contextPanelByDirectory['/project']?.tabs;
  const first = tabs?.find((tab) => tab.targetPath === 'https://first.example/');
  const second = tabs?.find((tab) => tab.targetPath === 'https://second.example/');
  if (!first || !second) throw new Error('Missing browser tabs');
  useServerBrowserAgentTab.getState().setAgentTab({ panelTabId: first.id, acting: false });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RuntimeAPIProvider apis={apis}><ThemeSystemProvider><SyncProvider sdk={sdk} directory="/project"><I18nProvider><ContextPanel /></I18nProvider></SyncProvider></ThemeSystemProvider></RuntimeAPIProvider>,
    ));
    const markedTab = () => [...container.querySelectorAll<HTMLElement>('[data-sortable-tab-id]')]
      .find((tab) => tab.querySelector('use[href="#oc-robot-2"]'));
    expect(markedTab()?.getAttribute('data-sortable-tab-id')).toBe(first.id);

    // When
    await act(async () => useServerBrowserAgentTab.getState().setAgentTab({ panelTabId: second.id, acting: true }));

    // Then
    expect(markedTab()?.getAttribute('data-sortable-tab-id')).toBe(second.id);
    expect(container.querySelectorAll('use[href="#oc-robot-2"]')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState(initialUI, true);
    useDirectoryStore.setState(initialDirectory, true);
    useServerBrowserAgentTab.setState(initialAgent, true);
    container.remove();
  }
});
