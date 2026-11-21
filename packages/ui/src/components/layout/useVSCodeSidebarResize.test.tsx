import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement, localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { useUIStore } = await import('@/stores/useUIStore');
const { useVSCodeSidebarResize } = await import('./useVSCodeSidebarResize');
const { flushDeferredStorage } = await import('@/stores/utils/safeStorage');

let width = 0;
let isResizing = false;
// The handle as VSCodeLayout wires it; `open` stands for the sidebar being shown.
const Probe = ({ open }: { open: boolean }) => {
  const resize = useVSCodeSidebarResize();
  width = resize.width;
  isResizing = resize.isResizing;
  return open ? (
    <div
      data-handle
      ref={resize.handleRef}
      onPointerDown={resize.onPointerDown}
      onPointerMove={resize.onPointerMove}
      onPointerUp={resize.onPointerEnd}
      onPointerCancel={resize.onPointerEnd}
      onLostPointerCapture={resize.onPointerEnd}
    />
  ) : null;
};

let container: HTMLElement;
let root: Root;
const render = async (open: boolean) => {
  await act(async () => root.render(<Probe open={open} />));
};
const fire = async (type: string, clientX = 0) => {
  const handle = container.querySelector('[data-handle]');
  if (!handle) throw new Error('resize handle is not mounted');
  await act(async () => {
    handle.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX }));
  });
};
const drag = async (from: number, to: number) => {
  await fire('pointerdown', from);
  await fire('pointermove', to);
};

beforeEach(() => {
  useUIStore.setState({ sidebarWidth: 300 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('saves the width on release, keeps the VS Code maximum at 520px and restores it after a reload', async () => {
  await render(true);
  await drag(0, 400);
  expect(width).toBe(520);
  expect(useUIStore.getState().sidebarWidth).toBe(300);
  await fire('pointerup', 400);
  expect(isResizing).toBe(false);
  expect(useUIStore.getState().sidebarWidth).toBe(520);

  // A webview reload: a fresh store rehydrates from what the release left in durable storage.
  const storage = useUIStore.persist.getOptions().storage;
  if (!storage) throw new Error('ui-store has no storage');
  flushDeferredStorage();
  const durable = await storage.getItem('ui-store');
  if (!durable) throw new Error('the release did not reach durable storage');
  expect(durable.state).toMatchObject({ sidebarWidth: 520 });
  await act(async () => root.unmount());
  useUIStore.setState(useUIStore.getInitialState(), true);
  await storage.setItem('ui-store', durable);
  flushDeferredStorage();
  expect(useUIStore.getState().sidebarWidth).toBe(280);
  await useUIStore.persist.rehydrate();
  root = createRoot(container);
  await render(true);
  expect(width).toBe(520);
});

test('hiding the sidebar mid-drag ends the drag and saves the preview width', async () => {
  await render(true);
  await drag(0, 60);
  expect(isResizing).toBe(true);
  await render(false);
  expect(isResizing).toBe(false);
  expect(useUIStore.getState().sidebarWidth).toBe(360);
  await render(true);
  expect(isResizing).toBe(false);
  expect(width).toBe(360);
});

test('losing pointer capture ends the drag', async () => {
  await render(true);
  await drag(0, -40);
  await fire('lostpointercapture');
  expect(isResizing).toBe(false);
  expect(useUIStore.getState().sidebarWidth).toBe(260);
  await fire('pointermove', 100);
  expect(width).toBe(260);
});
