import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSidebarMouseActions } from './sidebarMouseAction';

test('touch on a mouse action is suppressed while a touch menu remains usable', async () => {
  const win = new Window({ url: 'http://localhost/' });
  const globals = { window: win, document: win.document, navigator: win.navigator, Element: win.Element, Event: win.Event, PointerEvent: win.PointerEvent, MouseEvent: win.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let clicks = 0;
  function Fixture() {
    const { sidebarProps } = useSidebarMouseActions(false);
    return <div {...sidebarProps}><button data-sidebar-mouse-action onClick={() => clicks++}>Action</button><button onClick={() => clicks++}>Menu</button></div>;
  }
  try {
    await act(async () => root.render(<Fixture />));
    const [action, menu] = host.querySelectorAll('button');
    await act(async () => action.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })));
    expect(host.firstElementChild?.getAttribute('data-sidebar-mouse')).toBe('true');
    await act(async () => {
      action.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }));
      action.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(clicks).toBe(0);
    expect(host.firstElementChild?.hasAttribute('data-sidebar-mouse')).toBe(false);
    await act(async () => {
      menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      menu.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(clicks).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
