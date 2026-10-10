import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';

const REVEAL_LABEL = /Finder|File Explorer|file manager/i;

const ProjectItem = ({ onOpenFolder, SortableProjectItem }: { onOpenFolder?: () => void; SortableProjectItem: typeof import('./sortableItems').SortableProjectItem }) => {
  const [openMenuKey, setOpenMenuKey] = React.useState<string | null>(null);
  return (
    <SortableProjectItem
      id="project-1"
      projectLabel="repo"
      projectDescription="/repo"
      projectDirectory="/repo"
      isCollapsed={false}
      isRepo={false}
      hideDirectoryControls={false}
      mobileVariant={false}
      alwaysShowActions
      onToggle={() => undefined}
      onNewSession={() => undefined}
      onOpenFolder={onOpenFolder}
      onRenameStart={() => undefined}
      onClose={() => undefined}
      openSidebarMenuKey={openMenuKey}
      setOpenSidebarMenuKey={setOpenMenuKey}
    />
  );
};

const renderOpenProjectMenu = async (onOpenFolder?: () => void) => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement, Event: win.Event, MouseEvent: win.MouseEvent, PointerEvent: win.PointerEvent, KeyboardEvent: win.KeyboardEvent, getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  // These modules read the DOM when they load, so they come after the globals.
  const { createRoot } = await import('react-dom/client');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SortableProjectItem } = await import('./sortableItems');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <ThemeSystemProvider>
      <I18nProvider>
        <ProjectItem onOpenFolder={onOpenFolder} SortableProjectItem={SortableProjectItem} />
      </I18nProvider>
    </ThemeSystemProvider>,
  ));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Project menu"]');
  await act(async () => { trigger?.click(); });
  const revealItem = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => REVEAL_LABEL.test(item.textContent ?? '')) ?? null;
  const cleanup = async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  };
  return { revealItem, cleanup };
};

test('the project menu reveals the project folder when the runtime can', async () => {
  let opened = 0;
  const menu = await renderOpenProjectMenu(() => { opened += 1; });
  try {
    const item = menu.revealItem();
    expect(item).not.toBeNull();
    await act(async () => item?.click());
    expect(opened).toBe(1);
  } finally {
    await menu.cleanup();
  }
});

test('the project menu has no reveal entry without a reveal action', async () => {
  const menu = await renderOpenProjectMenu();
  try {
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
    expect(menu.revealItem()).toBeNull();
  } finally {
    await menu.cleanup();
  }
});
