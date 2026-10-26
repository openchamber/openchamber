import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useScrollShadow } from './useScrollShadow';

test('clears a retained scroller shadow on detach and restores it on reconnect', async () => {
  const dom = new Window();
  const globals = {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((name) => (
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  ));
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const node = document.createElement('div');
  host.append(node);
  node.scrollTop = 100;
  Object.defineProperties(node, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 500 },
  });
  const ref = { current: node };

  function Shadow() {
    useScrollShadow(ref, { observeMutations: false });
    return null;
  }

  try {
    await act(async () => root.render(<Shadow />));
    // Keep the scroll node connected when its observer disconnects, as in
    // a cached transcript switching to another session.
    host.append(node);
    expect(node.getAttribute('data-top-bottom-scroll')).toBe('true');
    await act(async () => root.render(null));
    expect(node.isConnected).toBe(true);
    expect(node.hasAttribute('data-top-bottom-scroll')).toBe(false);
    await act(async () => root.render(<Shadow />));
    expect(node.getAttribute('data-top-bottom-scroll')).toBe('true');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
    await dom.happyDOM.close();
  }
});
