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

const renderHeader = async () => {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { SidebarHeader } = await import('./SidebarHeader');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <I18nProvider>
      <TooltipProvider>
        <SidebarHeader
          hideDirectoryControls={false}
          showProjectDisplayControls
          showSectionControls
          handleOpenDirectoryDialog={() => undefined}
          showSourceBoard
          headerActionIconClass="h-4.5 w-4.5"
          headerActionButtonClass="inline-flex h-6 w-6"
          isSessionSearchOpen={false}
          openSessionSearch={() => undefined}
          closeSessionSearch={() => undefined}
          sessionSearchInputRef={React.createRef<HTMLInputElement | null>()}
          sessionSearchQuery=""
          setSessionSearchQuery={() => undefined}
          hasSessionSearchQuery={false}
          searchMatchCount={0}
          collapseAll={() => undefined}
          expandAll={() => undefined}
          showStats
        />
      </TooltipProvider>
    </I18nProvider>,
  ));
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More"]');
    if (!trigger) throw new Error('Missing More trigger');
    await act(async () => { trigger.click(); });
  };
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const item = (label: string) => items().find((entry) => entry.querySelector('.flex-1')?.textContent?.trim() === label);
  return { root, openMenu, items, item };
};

test('a page in the More menu opens and closes on the next pick', async () => {
  const restoreDom = installDom();
  const { useUIStore } = await import('@/stores/useUIStore');
  const initial = useUIStore.getState();
  const { root, openMenu, item } = await renderHeader();
  try {
    await act(async () => useUIStore.getState().setOverviewFeatureAvailable(true));
    for (const [label, isOpen] of [
      ['Archive', () => useUIStore.getState().isArchivePageOpen],
      ['Scheduled tasks', () => useUIStore.getState().isScheduledTasksDialogOpen],
      ['Issues and PRs', () => useUIStore.getState().isSourceBoardOpen],
      ['Overview', () => useUIStore.getState().isOverviewOpen],
    ] as const) {
      await openMenu();
      const entry = item(label);
      if (!entry) throw new Error(`Missing ${label}`);
      await act(async () => { entry.click(); });
      expect(isOpen()).toBe(true);
      await openMenu();
      await act(async () => { item(label)!.click(); });
      expect(isOpen()).toBe(false);
    }
  } finally {
    useUIStore.setState(initial);
    await act(async () => root.unmount());
    await restoreDom();
  }
});

test('without the overview feature the More menu has no Overview', async () => {
  const restoreDom = installDom();
  const { useUIStore } = await import('@/stores/useUIStore');
  const initial = useUIStore.getState();
  useUIStore.getState().setOverviewFeatureAvailable(false);
  const { root, openMenu, items } = await renderHeader();
  try {
    await openMenu();
    const labels = items().map((entry) => entry.querySelector('.flex-1')?.textContent?.trim());
    expect(labels).not.toContain('Overview');
    expect(labels).toContain('Issues and PRs');
    expect(labels).toContain('Stats');
  } finally {
    useUIStore.setState(initial);
    await act(async () => root.unmount());
    await restoreDom();
  }
});
