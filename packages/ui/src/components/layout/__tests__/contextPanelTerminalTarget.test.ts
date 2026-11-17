import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { setZoneBody, useZoneHostsStore } from '../zoneHosts';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useTerminalStore } from '@/stores/useTerminalStore';

let dom: Window;
let root: Root;
let observedDirectories: string[];
let restoreCapture: () => void;
let restoreFetch: () => void;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
  restoreFetch = () => fetchSpy.mockRestore();
  dom = new Window({ url: 'http://localhost' });
  dom.document.write('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Event: dom.Event, CustomEvent: dom.CustomEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    customElements: dom.customElements,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  useUIStore.setState({ contextPanelByDirectory: {}, contextSurfaceZones: {} });
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  useSessionUIStore.setState((state) => ({ currentSessionId: null, newSessionDraft: { ...state.newSessionDraft, open: false } }));
  useTerminalStore.setState({ hasHydrated: true });
  observedDirectories = [];
  const capture = useTerminalStore.getState().captureStartedActionMutationRevisions;
  const captureSpy = spyOn(useTerminalStore.getState(), 'captureStartedActionMutationRevisions').mockImplementation((directory) => {
    observedDirectories.push(directory);
    return capture(directory);
  });
  restoreCapture = () => captureSpy.mockRestore();
  useUIStore.getState().openContextPanelTab('/repo', { mode: 'terminal', targetDirectory: '/worktree' });
  const host = document.createElement('div');
  const zone = document.createElement('div');
  document.body.append(host, zone);
  setZoneBody('right', zone);
  root = createRoot(host);
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const web = createWebAPIs();
  const apis = { ...web, terminal: { ...web.terminal, listSessions: () => new Promise<never>(() => {}) } };
  const sdk = OpenCode.make({ baseUrl: 'http://terminal.test', fetch: () => new Promise<Response>(() => {}) });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const { ContextSurfacePanes } = await import('../ContextSurfacePanes');
  await act(async () => root.render(React.createElement(I18nProvider, null,
    React.createElement(ThemeSystemContext.Provider, { value: themeContext },
      React.createElement(RuntimeAPIContext.Provider, { value: apis },
        React.createElement(SyncProvider, { sdk, directory: '/repo', children: React.createElement(ContextSurfacePanes) }),
      ),
    ),
  )));
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreCapture();
  restoreFetch();
  useZoneHostsStore.setState({ body: { left: null, right: null, bottom: null } });
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('keeps a singleton terminal tab lookup independent of the active tab', async () => {
  const terminal = [...document.querySelectorAll('div')].filter((node) => node.textContent === 'Select a session to open the terminal.').at(-1);
  expect(terminal).toBeDefined();
  await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'git' }));
  expect(terminal?.isConnected).toBe(true);
});

test('passes the stored terminal targetDirectory into the mounted TerminalView', async () => {
  expect(observedDirectories).toEqual(['/worktree']);
  await act(async () => useUIStore.getState().openContextPanelTab('/repo', { mode: 'git' }));
  expect(observedDirectories).toEqual(['/worktree']);
});
