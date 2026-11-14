import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// Base UI reads the DOM globals when it loads, so the DOM goes in before the
// components are imported.
const installDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, CustomEvent: dom.CustomEvent, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  };
};

const renderPages = async () => {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { useSidebarPages } = await import('./useSidebarPages');
  const { SidebarPageRow } = await import('./SidebarPageRow');
  const Pages = () => {
    const pages = useSidebarPages(true);
    return <>{pages.map((page) => <SidebarPageRow key={page.id} page={page} />)}</>;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><TooltipProvider><Pages /></TooltipProvider></I18nProvider>));
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
  const labels = () => rows().map((row) => row.textContent?.trim());
  const row = (label: string) => rows().find((entry) => entry.textContent?.trim() === label);
  return { root, labels, row };
};

test('the pages come in their order, each row opens its page and closes it on the next press', async () => {
  const restoreDom = installDom();
  const { useUIStore } = await import('@/stores/useUIStore');
  const initial = useUIStore.getState();
  useUIStore.getState().setOverviewFeatureAvailable(true);
  const { root, labels, row } = await renderPages();
  try {
    expect(labels()).toEqual(['Overview', 'Issues and PRs', 'Scheduled tasks', 'Archive', 'Stats', 'Integrations catalog']);
    for (const [label, isOpen] of [
      ['Archive', () => useUIStore.getState().isArchivePageOpen],
      ['Scheduled tasks', () => useUIStore.getState().isScheduledTasksDialogOpen],
      ['Issues and PRs', () => useUIStore.getState().isSourceBoardOpen],
      ['Overview', () => useUIStore.getState().isOverviewOpen],
    ] as const) {
      await act(async () => { row(label)!.click(); });
      expect(isOpen()).toBe(true);
      expect(row(label)!.getAttribute('aria-pressed')).toBe('true');
      expect(row(label)!.className).toContain('oc-selected');
      await act(async () => { row(label)!.click(); });
      expect(isOpen()).toBe(false);
      expect(row(label)!.className).not.toContain('oc-selected');
    }
  } finally {
    useUIStore.setState(initial);
    await act(async () => root.unmount());
    await restoreDom();
  }
});

test('without the overview feature there is no Overview row', async () => {
  const restoreDom = installDom();
  const { useUIStore } = await import('@/stores/useUIStore');
  const initial = useUIStore.getState();
  useUIStore.getState().setOverviewFeatureAvailable(false);
  const { root, labels } = await renderPages();
  try {
    expect(labels()).not.toContain('Overview');
    expect(labels()[0]).toBe('Issues and PRs');
  } finally {
    useUIStore.setState(initial);
    await act(async () => root.unmount());
    await restoreDom();
  }
});
