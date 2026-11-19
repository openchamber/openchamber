import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

const empty = () => null;

test('mobile drawer keeps its terminal Escape exception', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Event: dom.Event, CustomEvent: dom.CustomEvent,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    customElements: dom.customElements,
    KeyboardEvent: dom.KeyboardEvent, MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closes = 0;
  try {
    const { MobileWorkspaceDrawer } = await import('@/apps/MobileWorkspaceDrawer');
    const { SyncProvider } = await import('@/sync/sync-context');
    const { OpenCode } = await import('@opencode/client');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    const apis = createWebAPIs();
    const sdk = OpenCode.make({ baseUrl: 'http://drawer.test', fetch: () => new Promise<Response>(() => {}) });
    const theme = getDefaultTheme(false);
    const themeContext: ThemeContextValue = {
      currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
      reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
      isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
      lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
    };
    const render = async (tab: 'terminal' | 'files') => {
      await act(async () => root.render(React.createElement(I18nProvider, null,
        React.createElement(ThemeSystemContext.Provider, { value: themeContext },
          React.createElement(RuntimeAPIContext.Provider, { value: apis },
            React.createElement(SyncProvider, { sdk, directory: '', children:
              React.createElement(MobileWorkspaceDrawer, {
                open: true, tab, onClose: () => { closes += 1; }, onTabChange: empty,
                registerPreviewBackHandler: empty, pendingChangesDiff: null, pendingChangesCommit: null,
                onOpenPlan: empty, onOpenReceivedPage: empty,
              }),
            }),
          ),
        ),
      )));
    };
    await render('terminal');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closes).toBe(0);
    await render('files');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    fetchSpy.mockRestore();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
