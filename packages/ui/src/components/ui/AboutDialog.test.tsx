import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

test('About shows the installed OpenCode version when the registry check fails', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(input instanceof Request ? input.url : input, dom.location.href).pathname;
    if (path === '/api/opencode/version') return Response.json({ version: '2.3.0' });
    if (path === '/api/system/info') return Response.json({ openchamberVersion: '2.5.6' });
    if (path === '/api/opencode/upgrade-status') return Response.json({ error: 'Registry unavailable' }, { status: 503 });
    if (path === '/api/fs/home') return Response.json({ home: '/home/test' });
    if (path === '/api/session') return Response.json({ items: [] });
    return Response.json({});
  });
  try {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const { AboutDialog } = await import('./AboutDialog');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <ThemeSystemProvider>
              <AboutDialog open onOpenChange={() => undefined} />
            </ThemeSystemProvider>
          </I18nProvider>,
        );
      });
      expect(document.body.textContent).toContain('OpenCode version 2.3.0');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    fetchSpy.mockRestore();
    await dom.happyDOM.close();
    for (const [key, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
