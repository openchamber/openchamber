import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { InstalledGuest } from '@/lib/guests/types';

// React DOM and the Base UI dialog probe for a DOM when first imported; without
// one the dialog never mounts its popup. Give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { GuestApprovalDialog } = await import('./GuestApprovalDialog');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();


const waiting: InstalledGuest = {
  id: 'teapot-tools', name: 'Teapot Tools', icon: 'cup', source: 'path', enabled: true, version: '1.0.0', opencodePlugin: true,
  capabilities: { requested: ['opencodePlugin'], granted: [] },
};

describe('the approval dialog for an extension that ships an OpenCode plugin', () => {
  let win: Window;
  let root: Root;
  let previous: Array<readonly [string, PropertyDescriptor | undefined]>;

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, MouseEvent: win.MouseEvent, Event: win.Event, CustomEvent: win.CustomEvent,
      getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const render = (guest: InstalledGuest | null) => act(async () => root.render(
    <I18nProvider>
      <GuestApprovalDialog guest={guest} busy={false} onApprove={() => {}} onDecline={() => {}} onDismiss={() => {}} />
    </I18nProvider>,
  ));

  test('asks for the plugin as its own row, with the line that it runs inside OpenCode', async () => {
    await render(null);
    await render(waiting);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Allow Teapot Tools?');
    expect(text).toContain('Add a plugin to OpenCode');
    expect(text).toContain("Loads this package's plugin into your OpenCode while the extension is on. Plugin code runs inside OpenCode with your full access, like the extension's service.");
  });
});
