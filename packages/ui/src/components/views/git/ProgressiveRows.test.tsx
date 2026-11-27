import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const withDom = async (run: (dom: Window) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
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

test('a list mounted inside a transition still commits its first rows before the rest', async () => {
  await withDom(async () => {
    const { createRoot } = await import('react-dom/client');
    const { ProgressiveRows } = await import('./ProgressiveRows');
    const limits: number[] = [];
    let show: (value: boolean) => void = () => {};
    const Host = () => {
      const [shown, setShown] = React.useState(false);
      show = setShown;
      return shown ? <ProgressiveRows minimum={0}>{(limit) => { limits.push(limit); return null; }}</ProgressiveRows> : null;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    await act(async () => React.startTransition(() => show(true)));
    expect(limits[0]).toBe(24);
    expect(limits.at(-1)).toBe(Number.POSITIVE_INFINITY);
    await act(async () => root.unmount());
  });
});

test('rows a file link expanded render in the first commit', async () => {
  await withDom(async () => {
    const { createRoot } = await import('react-dom/client');
    const { ProgressiveRows } = await import('./ProgressiveRows');
    const limits: number[] = [];
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<ProgressiveRows minimum={40}>{(limit) => { limits.push(limit); return null; }}</ProgressiveRows>));
    expect(limits[0]).toBe(40);
    await act(async () => root.unmount());
  });
});

test('scrolling to a section that mounts later scrolls once it registers', async () => {
  await withDom(async () => {
    const { createRoot } = await import('react-dom/client');
    const { useScrollToSection } = await import('./useScrollToSection');
    let api: ReturnType<typeof useScrollToSection> | null = null;
    const Probe = () => {
      api = useScrollToSection();
      return null;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    await act(async () => api?.scrollTo('working:src/late.ts'));
    const node = document.createElement('div');
    document.body.appendChild(node);
    let scrolled = 0;
    node.scrollIntoView = () => { scrolled += 1; };
    api!.registerSectionRef('working:src/late.ts', node);
    expect(scrolled).toBe(1);
    api!.registerSectionRef('working:src/late.ts', node);
    expect(scrolled).toBe(1);
    await act(async () => root.unmount());
  });
});
