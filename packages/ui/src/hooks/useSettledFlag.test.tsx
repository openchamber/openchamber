import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const withDom = async (run: (dom: Window) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run(dom);
  } finally {
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a wide body first mounted mid-animation waits for the panel to settle before mounting its diff', async () => {
  await withDom(async (dom) => {
    const { createRoot } = await import('react-dom/client');
    const { useSettledFlag } = await import('@/hooks/useSettledFlag');
    const { holdLayoutAnimation } = await import('@/lib/layoutAnimation');
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useSettledFlag(true));
      return null;
    };
    const root = createRoot(document.createElement('div'));
    const release = holdLayoutAnimation();
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    await act(async () => {
      release();
      await new Promise((resolve) => dom.requestAnimationFrame(() => resolve(null)));
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => root.unmount());
  });
});

test('an open menu follows the toolbar moving actions into it', async () => {
  await withDom(async () => {
    const { createRoot } = await import('react-dom/client');
    const { useToolbarStep } = await import('@/hooks/useToolbarStep');
    const toolbar = document.createElement('div');
    const ref = { current: toolbar };
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useToolbarStep(ref, 'data-step', true));
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    await act(async () => {
      toolbar.setAttribute('data-step', '');
      await Promise.resolve();
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => root.unmount());
  });
});
