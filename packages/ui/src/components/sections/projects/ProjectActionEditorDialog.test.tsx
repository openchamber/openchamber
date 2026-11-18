import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';

test('an action without runIn selects the readable current-worktree choice', async () => {
  const browser = new Window({ url: 'http://localhost' });
  const globals = {
    window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
    fetch: Object.assign(async () => Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' }), globalThis.fetch),
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    Event: browser.Event, CustomEvent: browser.CustomEvent, MouseEvent: browser.MouseEvent, HTMLInputElement: browser.HTMLInputElement,
    HTMLButtonElement: browser.HTMLButtonElement, MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const { ProjectActionEditorDialog } = await import('./ProjectActionEditorDialog');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><ProjectActionEditorDialog
      target={{ action: { id: 'dev', name: 'Dev', command: 'bun run dev' }, source: 'personal' }}
      canShare
      onOpenChange={() => undefined}
      onSave={async () => true}
      onDelete={async () => true}
    /></I18nProvider>));
    const group = document.querySelector('[aria-label="Working directory for this action"]');
    expect(group).not.toBeNull();
    const selected = group?.querySelector('[aria-pressed="true"], [aria-checked="true"]');
    expect(selected?.textContent).toBe('Current worktree');
    expect(group?.textContent).not.toContain('__project__');
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
