import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, DOMRect: win.DOMRect,
    HTMLElement: win.HTMLElement, getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Base UI reads the DOM globals when it loads, so the menus are imported after the DOM is installed.
const loadMenus = async () => ({
  ...(await import('@/components/ui/context-menu')),
  ...(await import('@/components/ui/dropdown-menu')),
  ...(await import('@/components/session/sidebar/sessions/useSessionRowMenuState')),
});
type Menus = Awaited<ReturnType<typeof loadMenus>>;
let menus: Menus;

const ControlledContextMenu = ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => {
  const { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } = menus;
  const [open, setOpen] = React.useState(true);
  return (
    <ContextMenu open={open} onOpenChange={(next) => { setOpen(next); onOpenChange(next); }}>
      <ContextMenuTrigger><div>file row</div></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>Rename</ContextMenuItem></ContextMenuContent>
    </ContextMenu>
  );
};

const SessionRowContextMenu = ({ pendingRename, completed }: { pendingRename: { current: boolean }; completed: string[] }) => {
  const { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, useSessionRowMenuState } = menus;
  const [openKey, setOpenKey] = React.useState<string | null>('session-context:a');
  const menu = useSessionRowMenuState({
    menuInstanceKey: 'session-menu:a',
    contextMenuInstanceKey: 'session-context:a',
    openSidebarMenuKey: openKey,
    setOpenSidebarMenuKey: setOpenKey,
    hasDeferredCloseWork: () => pendingRename.current,
    onCloseComplete: () => {
      if (!pendingRename.current) return;
      pendingRename.current = false;
      completed.push('rename');
    },
  });
  return (
    <ContextMenu open={menu.isContextMenuOpen} onOpenChange={menu.handleContextMenuOpenChange} onOpenChangeComplete={menu.handleMenuOpenChangeComplete}>
      <ContextMenuTrigger><div data-open-key={openKey ?? ''}>session row</div></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>Rename</ContextMenuItem></ContextMenuContent>
    </ContextMenu>
  );
};

describe('menus when the window loses focus', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;

  beforeEach(async () => {
    dom = installDom();
    menus = await loadMenus();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  const menuOpen = () => document.querySelector('[role="menu"]') !== null;
  const blurWindow = async () => {
    await act(async () => {
      window.dispatchEvent(new window.Event('blur'));
      await wait(50);
    });
  };

  test('a controlled context menu reports the close and disappears', async () => {
    const changes: boolean[] = [];
    await act(async () => root.render(<ControlledContextMenu onOpenChange={(open) => changes.push(open)} />));
    expect(menuOpen()).toBe(true);
    expect(document.documentElement.classList.contains('oc-menu-open')).toBe(true);

    await blurWindow();
    expect(changes).toEqual([false]);
    expect(menuOpen()).toBe(false);
    expect(document.documentElement.classList.contains('oc-menu-open')).toBe(false);
  });

  test('a session row menu with a pending rename closes and still runs the rename', async () => {
    const pendingRename = { current: true };
    const completed: string[] = [];
    await act(async () => root.render(<SessionRowContextMenu pendingRename={pendingRename} completed={completed} />));
    expect(menuOpen()).toBe(true);

    await blurWindow();
    await act(async () => { await wait(200); });
    expect(menuOpen()).toBe(false);
    expect(completed).toEqual(['rename']);
    expect(document.querySelector('[data-open-key]')?.getAttribute('data-open-key')).toBe('');
  });

  test('an uncontrolled dropdown menu closes', async () => {
    const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = menus;
    await act(async () => root.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild><button type="button">More</button></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>Rename</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    ));
    expect(menuOpen()).toBe(true);

    await blurWindow();
    expect(menuOpen()).toBe(false);
    expect(document.documentElement.classList.contains('oc-menu-open')).toBe(false);
  });

  test('the title bar stays undraggable until the last open menu closes', async () => {
    const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = menus;
    await act(async () => root.render(
      <>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild><button type="button">First</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open>
          <DropdownMenuTrigger asChild><button type="button">Second</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>Two</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      </>,
    ));
    expect(document.documentElement.classList.contains('oc-menu-open')).toBe(true);

    // The second menu is pinned open by its owner, so the class stays.
    await blurWindow();
    expect(document.querySelectorAll('[role="menu"]').length).toBe(1);
    expect(document.documentElement.classList.contains('oc-menu-open')).toBe(true);
  });
});
