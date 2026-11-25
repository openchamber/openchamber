import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { I18nProvider } from '@/lib/i18n';

let testWindow: Window;
let root: Root;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  testWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: testWindow,
    document: testWindow.document,
    Event: testWindow.Event,
    CustomEvent: testWindow.CustomEvent,
    KeyboardEvent: testWindow.KeyboardEvent,
    navigator: testWindow.navigator,
    HTMLElement: testWindow.HTMLElement,
    Element: testWindow.Element,
    Node: testWindow.Node,
    getComputedStyle: testWindow.getComputedStyle.bind(testWindow),
    requestAnimationFrame: testWindow.requestAnimationFrame.bind(testWindow),
    cancelAnimationFrame: testWindow.cancelAnimationFrame.bind(testWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previousGlobals = new Map(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  testWindow.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('Escape that dismisses an IME candidate leaves the panel open, a clean one closes it', async () => {
  let closed = 0;
  await act(async () => root.render(
    <I18nProvider>
      <MobileOverlayPanel open title="Panel" onClose={() => { closed += 1; }}>
        <input />
      </MobileOverlayPanel>
    </I18nProvider>,
  ));
  const input = document.querySelector('input');
  if (!input) throw new Error('the panel did not render');
  const press = (init: KeyboardEventInit) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init }));
  });

  await press({ isComposing: true });
  expect(closed).toBe(0);
  await press({});
  expect(closed).toBe(1);
});
