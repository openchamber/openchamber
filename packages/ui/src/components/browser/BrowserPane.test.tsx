import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { AGENT_BROWSER_PARTITION } from '@/lib/browser/contract';
import { useUIStore } from '@/stores/useUIStore';
import { BrowserPane } from './BrowserPane';

for (const [ownerSessionId, agentBrowserSharesLogins] of [
  [null, false], [null, true], ['session-fixture', false], ['session-fixture', true],
] as const) {
  test(`keeps ${ownerSessionId === null ? 'user' : 'agent'} tab ownership with login sharing ${agentBrowserSharesLogins ? 'on' : 'off'}`, async () => {
    const dom = new Window({ url: 'http://localhost/' });
    const globals = {
      window: Object.assign(dom, { __OPENCHAMBER_ELECTRON__: { runtime: 'desktop' } }),
      document: dom.document,
      navigator: dom.navigator,
      localStorage: dom.localStorage,
      Element: dom.Element,
      HTMLElement: dom.HTMLElement,
      ResizeObserver: dom.ResizeObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    }
    const browserProvider = useUIStore.getState().browserProvider;
    const contextPanelByDirectory = useUIStore.getState().contextPanelByDirectory;
    const contextRailOrder = useUIStore.getState().contextRailOrder;
    const previousSharesLogins = useUIStore.getState().agentBrowserSharesLogins;
    useUIStore.setState({ browserProvider: BUILTIN_BROWSER_PROVIDER, contextPanelByDirectory: {}, agentBrowserSharesLogins });
    const tabID = ownerSessionId
      ? useUIStore.getState().openAgentBrowserTab('/fixture', 'about:blank', ownerSessionId)
      : 'popup-test';
    const openedTab = useUIStore.getState().contextPanelByDirectory['/fixture']?.tabs.find((tab) => tab.id === tabID);
    if (ownerSessionId !== null) expect(openedTab).toMatchObject({ id: tabID, ownerSessionId });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <ThemeSystemProvider>
            <BrowserPane
              initialUrl="about:blank"
              directory="/fixture"
              siteDirectory="/fixture"
              tabID={tabID ?? 'missing-tab'}
              ownerSessionId={openedTab?.ownerSessionId ?? null}
              visible
            />
          </ThemeSystemProvider>
        </I18nProvider>,
      ));
      const webview = dom.document.querySelector('webview');
      expect(webview).not.toBeNull();
      expect(webview?.hasAttribute('allowpopups')).toBe(true);
      expect(webview?.getAttribute('partition')).toBe(ownerSessionId !== null && !agentBrowserSharesLogins
        ? AGENT_BROWSER_PARTITION
        : 'persist:openchamber-browser');
      expect(webview?.getAttribute('webpreferences')).toBe(
        ownerSessionId === null ? null : 'backgroundThrottling=no',
      );
    } finally {
      await act(async () => root.unmount());
      useUIStore.setState({ browserProvider, contextPanelByDirectory, contextRailOrder, agentBrowserSharesLogins: previousSharesLogins });
      await dom.happyDOM.close();
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
