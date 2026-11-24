import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('the wide layout follows the zone target when a resize animation starts, not the width mid-animation', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const observers: Array<() => void> = [];
  class ManualResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    disconnect() {}
    unobserve() {}
  }
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    ResizeObserver: ManualResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { useUnifiedGitPanel } = await import('./useUnifiedGitPanel');
  const { holdLayoutAnimation } = await import('@/lib/layoutAnimation');

  const zone = document.createElement('div');
  zone.setAttribute('data-context-panel', 'true');
  zone.dataset.zoneAxis = 'width';
  document.body.append(zone);
  let width = 1200;
  const seen: boolean[] = [];
  const Probe = () => {
    const panel = useUnifiedGitPanel({ isActive: true, isMobile: false, diffScope: null, targetFilePath: null });
    seen.push(panel.isWide);
    const { setRootRef } = panel;
    const attach = React.useCallback((node: HTMLDivElement | null) => {
      if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width });
      setRootRef(node);
    }, [setRootRef]);
    return <div ref={attach} />;
  };
  const root = createRoot(zone);
  try {
    zone.dataset.zoneSize = '1214';
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe(true);

    zone.dataset.zoneSize = '494';
    let release = () => {};
    await act(async () => { release = holdLayoutAnimation(); });
    expect(seen.at(-1)).toBe(false);

    const renders = seen.length;
    width = 900;
    await act(async () => observers.forEach((notify) => notify()));
    expect(seen.length).toBe(renders);

    width = 480;
    await act(async () => {
      release();
      await new Promise((resolve) => dom.requestAnimationFrame(() => resolve(null)));
    });
    expect(seen.at(-1)).toBe(false);

    width = 850;
    await act(async () => observers.forEach((notify) => notify()));
    expect(seen.at(-1)).toBe(true);

    zone.dataset.zoneAxis = 'height';
    zone.dataset.zoneSize = '300';
    await act(async () => { release = holdLayoutAnimation(); });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      release();
      await new Promise((resolve) => dom.requestAnimationFrame(() => resolve(null)));
    });
    expect(seen.at(-1)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
