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

const linkOnly: InstalledGuest = {
  id: 'deploy-log', name: 'Deploy Log', icon: 'rocket', source: 'path', enabled: true, version: '1.0.0', marks: true,
  service: { runtime: 'host', granted: false },
  capabilities: { requested: ['service', 'marks'], granted: [] },
};

describe('the approval dialog for an extension that shows marks', () => {
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

  test('asks for the marks as their own row and says what a click opens', async () => {
    await render(null);
    await render(linkOnly);
    const withoutPanel = document.body.textContent ?? '';
    expect(withoutPanel).toContain('Show marks in the sidebar');
    expect(withoutPanel).toContain('Small icons with a tooltip on the sessions and worktrees it names.');
    expect(withoutPanel).toContain('A click opens the link it gives.');
    expect(withoutPanel).not.toContain('A click opens its panel.');

    await render({ ...linkOnly, entry: 'panel/index.html' });
    const withPanel = document.body.textContent ?? '';
    expect(withPanel).toContain('A click opens its panel.');
    expect(withPanel).not.toContain('A click opens the link it gives.');
  });
});
