import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { GoalObjectiveVersion } from '@/lib/goalObjectiveFiles';
import type { GoalVersionHistoryProps } from './GoalVersionHistory';

// The component reads only injected loaders, so the test drives the list,
// the read-only view and Restore without touching the server or mocking a
// module. React DOM needs a document at import time; give it one, then
// restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document', 'localStorage'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: importWindow.localStorage, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { GoalVersionHistory } = await import('./GoalVersionHistory');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true, Event: win.Event, CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

const flush = async () => {
  await act(async () => { await Promise.resolve(); });
};

/** The version rows as buttons; the selector targets the component's own markup. */
const versionRows = (container: HTMLElement): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goal-version-list"] li button')];

const versions: GoalObjectiveVersion[] = [
  { id: 'v2', savedAt: Date.UTC(2026, 10, 8, 10, 0) },
  { id: 'v1', savedAt: Date.UTC(2026, 10, 7, 9, 0) },
];
const texts = new Map<string, string>([['v1', 'older spec text'], ['v2', 'current spec text']]);

const render = async (props: Partial<GoalVersionHistoryProps> = {}) => {
  const dom = installDom();
  const root: Root = createRoot(dom.container);
  const restored: string[] = [];
  const full: GoalVersionHistoryProps = {
    sessionId: 'ses_test',
    currentObjective: 'current spec text',
    onRestore: (content) => restored.push(content),
    locale: 'en',
    loadVersions: async () => versions,
    loadVersionContent: async (_sessionId, versionId) => texts.get(versionId) ?? null,
    ...props,
  };
  await act(async () => {
    root.render(<I18nProvider><GoalVersionHistory {...full} /></I18nProvider>);
  });
  await flush();
  return {
    dom,
    restored,
    text: () => dom.container.textContent ?? '',
    buttons: () => [...dom.container.querySelectorAll('button')],
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      dom.restore();
    },
  };
};

afterEach(() => {
  // Globals are restored per render; nothing outlives a test's own cleanup.
});

describe('GoalVersionHistory (#1830)', () => {
  test('lists the retained versions, newest first', async () => {
    const view = await render();
    const list = view.dom.container.querySelector('[data-testid="goal-version-list"]');
    expect(list).not.toBeNull();
    const rows = [...(list?.querySelectorAll('li') ?? [])];
    expect(rows).toHaveLength(2);
    await view.cleanup();
  });

  test('shows a prior version read-only and restores it', async () => {
    const view = await render();
    const rows = versionRows(view.dom.container);
    // v1 is the second row (older).
    await act(async () => { rows[1].click(); });
    await flush();

    const content = view.dom.container.querySelector('[data-testid="goal-version-content"]');
    expect(content?.textContent).toBe('older spec text');
    // Read-only: the version text is not an editable field.
    expect(content?.querySelector('textarea')).toBeNull();

    const restore = view.buttons().find((button) => /restore/i.test(button.textContent ?? ''));
    expect(restore).toBeDefined();
    await act(async () => { restore?.click(); });
    expect(view.restored).toEqual(['older spec text']);
    await view.cleanup();
  });

  test('does not offer a restore for the current version', async () => {
    const view = await render();
    const rows = versionRows(view.dom.container);
    await act(async () => { rows[0].click(); });
    await flush();
    expect(view.dom.container.querySelector('[data-testid="goal-version-content"]')?.textContent).toBe('current spec text');
    const restore = view.buttons().find((button) => /restore/i.test(button.textContent ?? ''));
    expect(restore).toBeUndefined();
    await view.cleanup();
  });

  test('shows an empty state when there are no earlier versions', async () => {
    const view = await render({ loadVersions: async () => [] });
    expect(view.text()).toContain('No earlier versions yet');
    expect(view.dom.container.querySelector('[data-testid="goal-version-list"]')).toBeNull();
    await view.cleanup();
  });

  test('distinguishes an unreadable history from an empty one', async () => {
    const view = await render({ loadVersions: async () => null });
    expect(view.text()).toContain('could not be loaded');
    expect(view.text()).not.toContain('No earlier versions yet');
    await view.cleanup();
  });

  test('reports a version whose text cannot be read', async () => {
    const view = await render({ loadVersionContent: async () => null });
    const rows = versionRows(view.dom.container);
    await act(async () => { rows[1].click(); });
    await flush();
    expect(view.text()).toContain('This version could not be loaded');
    expect(view.dom.container.querySelector('[data-testid="goal-version-content"]')).toBeNull();
    await view.cleanup();
  });
});
