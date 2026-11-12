import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ProjectEntry } from '@/lib/api/types';

describe('ProjectsPage', () => {
  let dom: Window;
  let root: Root | undefined;
  let restoreStores = () => {};
  let closed: string[] = [];
  const globals = new Map<string, PropertyDescriptor | undefined>();

  const projects: ProjectEntry[] = [
    { id: 'alpha', path: '/repo/alpha', label: 'Alpha' },
    { id: 'beta', path: '/repo/beta', label: 'Beta' },
  ];

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    // The tab strip and the scroll area measure themselves, the confirm dialog
    // mounts through a portal, and the project's setup read goes through fetch.
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement,
      DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent,
      PointerEvent: dom.PointerEvent, Event: dom.Event, CustomEvent: dom.CustomEvent,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
      fetch: async () => new Response('{}', { status: 404 }),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    closed = [];
  });

  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
    root = undefined;
    restoreStores();
    await dom.happyDOM.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  // Loaded after the DOM globals exist: the dialog's portal checks for a
  // document when its module loads.
  const render = async () => {
    const { createRoot } = await import('react-dom/client');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const { I18nProvider } = await import('@/lib/i18n');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useUIStore } = await import('@/stores/useUIStore');
    const { ProjectsPage } = await import('./ProjectsPage');

    const initialProjects = useProjectsStore.getState();
    const initialSelectedId = useUIStore.getState().settingsProjectsSelectedId;
    restoreStores = () => {
      useProjectsStore.setState({ projects: initialProjects.projects, removeProject: initialProjects.removeProject });
      useUIStore.setState({ settingsProjectsSelectedId: initialSelectedId });
    };
    useProjectsStore.setState({ projects, removeProject: (id) => { closed.push(id); } });
    useUIStore.setState({ settingsProjectsSelectedId: 'beta' });

    const container = document.createElement('div');
    document.body.append(container);
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    await act(async () => {
      mountedRoot.render(<ThemeSystemProvider><I18nProvider><ProjectsPage /></I18nProvider></ThemeSystemProvider>);
    });
  };

  const buttonsLabelled = (text: string) => Array.from(document.querySelectorAll('button'))
    .filter((button) => button.textContent?.trim() === text);

  const openConfirm = async () => {
    const closeButton = document.querySelector<HTMLButtonElement>('[data-settings-item="projects.close"]');
    if (!closeButton) throw new Error('Missing Close project button');
    expect(closeButton.textContent?.trim()).toBe('Close project');
    await act(async () => { closeButton.click(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Close Beta?');
  };

  test('Close project asks first, and Cancel keeps the project', async () => {
    await render();
    await openConfirm();
    const [cancel] = buttonsLabelled('Cancel');
    if (!cancel) throw new Error('Missing Cancel button');
    await act(async () => { cancel.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(closed).toEqual([]);
  });

  test('confirming closes the shown project through the store, as the sidebar does', async () => {
    await render();
    await openConfirm();
    const confirmButton = document.querySelector('[role="dialog"]')
      ?.querySelector<HTMLButtonElement>('[data-slot="dialog-footer"] button:last-child');
    expect(confirmButton?.textContent?.trim()).toBe('Close project');
    await act(async () => { confirmButton?.click(); });
    expect(closed).toEqual(['beta']);
  });
});
