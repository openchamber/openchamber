import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('a virtualized change list returns to its offset after a diff replaced it', async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.happyDOM.setWindowSize({ width: 1280, height: 800 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  try {
    const { createRoot } = await import('react-dom/client');
    const { ChangesPanel } = await import('./ChangesPanel');
    const { I18nProvider } = await import('@/lib/i18n');

    // At 1,000 rows the list is virtualized, and the virtualizer writes its own
    // offset to the scroller when it attaches.
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      path: `src/file-${String(index).padStart(4, '0')}.ts`, index: ' ', working_dir: 'M',
    }));
    const noop = () => {};
    const Panel = () => (
      <I18nProvider><ChangesPanel
        groups={[{
          id: 'working', title: 'Changes', entries, statsScope: 'working', actionSymbol: '+', actionAllLabel: 'Stage all',
          getActionLabel: () => 'Stage', onActionFile: noop, onActionAll: noop, onViewDiff: noop, onRevertFile: noop,
        }]}
        diffStats={undefined}
        revertingPaths={new Set()}
        memoryKey="changes:test:/repo"
        memoryReady
      /></I18nProvider>
    );
    const scroller = (host: HTMLElement): HTMLElement => {
      const node = host.querySelector('.overlay-scrollbar-target');
      if (!(node instanceof window.HTMLElement)) throw new Error('the change list did not render');
      return node;
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const first = createRoot(host);
    await act(async () => first.render(<Panel />));
    const list = scroller(host);
    list.scrollTop = 900;
    await act(async () => { list.dispatchEvent(new window.Event('scroll')); });

    // Opening a diff unmounts the list; returning mounts a new one.
    await act(async () => first.unmount());
    const second = createRoot(host);
    await act(async () => second.render(<Panel />));
    expect(scroller(host).scrollTop).toBe(900);
    await act(async () => second.unmount());
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
