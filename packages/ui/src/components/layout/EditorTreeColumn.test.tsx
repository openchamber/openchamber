import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    PointerEvent: browser.PointerEvent,
    MouseEvent: browser.MouseEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const renderColumn = async () => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { EditorTreeColumn } = await import('./EditorTreeColumn');
  await act(async () => root.render(
    <I18nProvider>
      <EditorTreeColumn visible side="right">
        <button type="button" data-testid="row">README.md</button>
      </EditorTreeColumn>
    </I18nProvider>,
  ));
  const grip = document.querySelector<HTMLElement>('[role="separator"]');
  const row = document.querySelector<HTMLElement>('[data-testid="row"]');
  if (!grip || !row) throw new Error('column did not render');
  return { grip, treeTakesPointer: () => !row.parentElement?.classList.contains('pointer-events-none') };
};

const pointer = (type: string, init: PointerEventInit = {}) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 300, ...init });

// The tree ignores the pointer while its width grip is held. On macOS the release can land in
// another app when the user switches windows mid-press, and the tree used to stay dead after that.
const loseReleaseAfterPress = async (loseRelease: () => void) => {
  const { grip, treeTakesPointer } = await renderColumn();
  await act(async () => grip.dispatchEvent(pointer('pointerdown')));
  expect(treeTakesPointer()).toBe(false);
  await act(async () => loseRelease());
  return treeTakesPointer();
};

test('the file tree takes the pointer again when the release lands outside the grip', async () => {
  expect(await loseReleaseAfterPress(() => document.body.dispatchEvent(pointer('pointerup', { clientX: 40 })))).toBe(true);
});

test('the file tree takes the pointer again when the window loses focus before the release', async () => {
  expect(await loseReleaseAfterPress(() => window.dispatchEvent(new Event('blur')))).toBe(true);
});

test('a drag released on the grip keeps the new tree width', async () => {
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore.getState().setContextEditorTreeWidth(240);
  const { grip, treeTakesPointer } = await renderColumn();

  await act(async () => grip.dispatchEvent(pointer('pointerdown')));
  await act(async () => grip.dispatchEvent(pointer('pointermove', { clientX: 260 })));
  await act(async () => grip.dispatchEvent(pointer('pointerup', { clientX: 260 })));

  expect(useUIStore.getState().contextEditorTreeWidth).toBe(280);
  expect(treeTakesPointer()).toBe(true);
});
