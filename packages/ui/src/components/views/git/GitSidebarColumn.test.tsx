import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('the Git sidebar keeps its saved width on a click without a drag, and resizes from the keyboard', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
    PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  try {
    const { GitSidebarColumn } = await import('./GitSidebarColumn');
    const { I18nProvider } = await import('@/lib/i18n');
    const { useUIStore } = await import('@/stores/useUIStore');
    useUIStore.getState().setGitSidebarWidth(520);

    await act(async () => root.render(
      <I18nProvider><div><GitSidebarColumn><span /></GitSidebarColumn></div></I18nProvider>,
    ));
    const separator = host.querySelector<HTMLElement>('[role="separator"]');
    const column = separator?.parentElement;
    const row = column?.parentElement;
    if (!separator || !column || !row) throw new Error('sidebar not rendered');
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => 720 });
    column.getBoundingClientRect = () => ({ width: 360 } as DOMRect);
    separator.setPointerCapture = () => {};

    await act(async () => {
      separator.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 360 }));
      separator.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 360 }));
    });
    expect(useUIStore.getState().gitSidebarWidth).toBe(520);
    expect(separator.tabIndex).toBe(0);

    await act(async () => {
      separator.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    });
    expect(useUIStore.getState().gitSidebarWidth).toBe(344);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
