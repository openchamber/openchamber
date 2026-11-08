import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { BrowserPane } from './BrowserPane';

for (const ownerSessionId of [null, 'session-fixture']) {
  test(`renders popup permission for ${ownerSessionId === null ? 'user' : 'agent'} browser tabs`, async () => {
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
    Object.assign(globalThis, globals);
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
              tabID="popup-test"
              ownerSessionId={ownerSessionId}
              visible
            />
          </ThemeSystemProvider>
        </I18nProvider>,
      ));
      const webview = dom.document.querySelector('webview');
      expect(webview).not.toBeNull();
      expect(webview?.hasAttribute('allowpopups')).toBe(true);
      expect(webview?.getAttribute('webpreferences')).toBe(
        ownerSessionId === null ? null : 'backgroundThrottling=no',
      );
    } finally {
      await act(async () => root.unmount());
      await dom.happyDOM.close();
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
