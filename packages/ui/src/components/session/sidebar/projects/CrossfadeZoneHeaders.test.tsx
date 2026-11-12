import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('uses virtual row starts for zone handoffs', async () => {
  const dom = new Window({ url: 'http://localhost' });
  Object.defineProperty(dom, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const { CrossfadeZoneHeader, CrossfadeZoneHeaders } = await import('./CrossfadeZoneHeaders');
  const root = createRoot(container);
  const scrollRef = React.createRef<HTMLDivElement>();

  try {
    await act(async () => root.render(
      <CrossfadeZoneHeaders scrollRef={scrollRef}>
        <div ref={scrollRef}>
          <div data-sidebar-virtual-start="0"><CrossfadeZoneHeader><button type="button">First</button></CrossfadeZoneHeader></div>
          <div data-sidebar-virtual-start="100"><CrossfadeZoneHeader>Second</CrossfadeZoneHeader></div>
        </div>
      </CrossfadeZoneHeaders>,
    ));

    const layer = container.querySelector<HTMLElement>('[data-sidebar-crossfade-layer]');
    expect(layer?.textContent).toBe('First');

    const scroller = scrollRef.current;
    if (!scroller) throw new Error('Missing test scroller');
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('scroll'));
    expect(layer?.textContent).toBe('Second');

    // A header clicked a moment ago keeps focus. Chromium scrolls a moved
    // focused element into view; handing it back to its section above the
    // viewport must not throw the list back to the top.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    const button = layer?.querySelector('button');
    if (!button) throw new Error('Missing focusable header');
    button.focus();
    const prototype = dom.HTMLElement.prototype as unknown as { moveBefore?: (node: Node, child: Node | null) => void };
    prototype.moveBefore = function moveBefore(this: HTMLElement, node: Node, child: Node | null) {
      const movesFocus = node.contains(document.activeElement);
      this.insertBefore(node, child);
      if (movesFocus && !this.closest('[data-sidebar-crossfade-layer]')) scroller.scrollTop = 0;
    };
    try {
      scroller.scrollTop = 100;
      scroller.dispatchEvent(new Event('scroll'));
      expect(scroller.scrollTop).toBe(100);
      expect(layer?.textContent).toBe('Second');
    } finally {
      delete prototype.moveBefore;
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
