import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let dom: Window;
let host: HTMLElement;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  dom = new Window({ url: 'http://localhost' });
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.abort();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

const renderSidebar = async (storedWidth: number) => {
  const { GitSidebarColumn } = await import('./GitSidebarColumn');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore.getState().setGitSidebarWidth(storedWidth);

  await act(async () => root.render(
    <I18nProvider><div><GitSidebarColumn><span /></GitSidebarColumn></div></I18nProvider>,
  ));
  const separator = host.querySelector<HTMLElement>('[role="separator"]');
  const column = separator?.parentElement;
  const row = column?.parentElement;
  if (!separator || !column || !row) throw new Error('sidebar not rendered');
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => 1000 });
  column.getBoundingClientRect = () => ({ width: 360 } as DOMRect);
  separator.setPointerCapture = () => {};
  separator.hasPointerCapture = () => false;
  return { separator, column, storedWidth: () => useUIStore.getState().gitSidebarWidth };
};

const pointer = (type: string, clientX: number) => new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX });

test('the Git sidebar keeps its saved width on a click without a drag, and resizes from the keyboard', async () => {
  const { separator, storedWidth } = await renderSidebar(520);

  await act(async () => separator.dispatchEvent(pointer('pointerdown', 360)));
  await act(async () => separator.dispatchEvent(pointer('pointerup', 360)));
  expect(storedWidth()).toBe(520);
  expect(separator.tabIndex).toBe(0);

  await act(async () => {
    separator.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
  });
  expect(storedWidth()).toBe(344);
}, 30_000);

// On macOS the release of a press on the grip can land in another app when the user switches
// windows mid-press. The grip used to stay highlighted, and the column then followed the mouse
// with the button up without saving the width.
const loseReleaseMidDrag = async (loseRelease: () => void) => {
  const sidebar = await renderSidebar(360);
  await act(async () => sidebar.separator.dispatchEvent(pointer('pointerdown', 360)));
  await act(async () => sidebar.separator.dispatchEvent(pointer('pointermove', 400)));
  await act(async () => loseRelease());
  await act(async () => sidebar.separator.dispatchEvent(pointer('pointermove', 300)));
  return sidebar;
};

test('a Git sidebar drag ends when the release lands outside the grip', async () => {
  const { separator, column, storedWidth } = await loseReleaseMidDrag(() => document.body.dispatchEvent(pointer('pointerup', 400)));
  expect(storedWidth()).toBe(400);
  expect(column.style.width).toBe('400px');
  expect(separator.classList.contains('bg-[var(--interactive-border)]')).toBe(false);
}, 30_000);

test('a Git sidebar drag ends when the window loses focus before the release', async () => {
  const { separator, column, storedWidth } = await loseReleaseMidDrag(() => window.dispatchEvent(new window.Event('blur')));
  expect(storedWidth()).toBe(400);
  expect(column.style.width).toBe('400px');
  expect(separator.classList.contains('bg-[var(--interactive-border)]')).toBe(false);
}, 30_000);
