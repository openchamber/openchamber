import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

for (const queued of [true, false]) test(`idle install ${queued ? 'closes' : 'keeps'} the dialog after the request`, async () => {
  const dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.entries(values).map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const { I18nProvider } = await import('@/lib/i18n');
    const { UpdateDialog } = await import('./UpdateDialog');
    let open = true;
    let finishQueue!: (queued: boolean) => void;
    const props = {
      open: true,
      onOpenChange: (value: boolean) => { open = value; },
      info: { available: true, version: '2.7.3', currentVersion: '2.7.2' },
      downloading: false, downloaded: true, progress: null, error: null,
      onDownload: () => {}, onRestart: () => {},
      onInstallWhenIdle: () => new Promise<boolean>((resolve) => { finishQueue = resolve; }),
      runtimeType: 'desktop' as const,
    };
    await act(async () => root.render(<I18nProvider><UpdateDialog {...props} /></I18nProvider>));
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Install when idle'));
    expect(button).toBeDefined();
    await act(async () => { button?.click(); await Promise.resolve(); });
    expect(open).toBe(true);
    await act(async () => { finishQueue(queued); await Promise.resolve(); });
    expect(open).toBe(!queued);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
