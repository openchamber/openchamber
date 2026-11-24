import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let menus: typeof import('./dropdown-menu');
let dom: Window;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent, FocusEvent: dom.FocusEvent,
    DOMRect: dom.DOMRect, getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: dom.setTimeout.bind(dom), clearTimeout: dom.clearTimeout.bind(dom),
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  menus = await import('./dropdown-menu');
  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

const SearchMenu = ({ openOnHover = false }: { openOnHover?: boolean }) => {
  const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } = menus;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key === 'm') setOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger openOnHover={openOnHover} delay={0}>Models</DropdownMenuTrigger>
      <DropdownMenuContent>
        <input aria-label="Search models" autoFocus value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        {['Luna', 'Astra'].filter((name) => name.toLowerCase().includes(query)).map((name) => <div key={name}>{name}</div>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const openWithShortcut = async () => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', metaKey: true, shiftKey: true, bubbles: true }));
  });
};

const leavePopup = async () => {
  const popup = document.querySelector<HTMLElement>('[role="menu"]');
  expect(popup !== null).toBe(true);
  await act(async () => {
    // Filtering can shrink the popup away from a stationary mouse. The browser
    // sends the same native mouseleave as a deliberate move outside it.
    popup!.parentElement!.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
  });
};

test('a shortcut-opened search menu survives filtering under the pointer and still dismisses explicitly', async () => {
  await act(async () => root.render(<SearchMenu />));
  await openWithShortcut();
  const input = document.querySelector<HTMLInputElement>('input');
  expect(document.activeElement === input).toBe(true);
  await act(async () => {
    input!.value = 'astr';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.querySelector('[role="menu"]')?.textContent).toBe('Astra');

  await leavePopup();
  expect(document.querySelector('[role="menu"]') !== null).toBe(true);
  expect(document.activeElement === input).toBe(true);
  expect(input!.value).toBe('astr');

  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(document.querySelector('[role="menu"]') === null).toBe(true);

  await openWithShortcut();
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

test('hover-opened menus still close on mouseleave, without affecting a later shortcut opening', async () => {
  await act(async () => root.render(<SearchMenu openOnHover />));
  const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  });
  await leavePopup();
  expect(document.querySelector('[role="menu"]') === null).toBe(true);

  await openWithShortcut();
  await leavePopup();
  expect(document.querySelector('[role="menu"]') !== null).toBe(true);
});

// A popup taller than its cap scrolls; happy-dom does no layout, so the sizes are given here.
const makeScrollable = (popup: HTMLElement) => {
  Object.defineProperty(popup, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(popup, 'offsetHeight', { configurable: true, value: 200 });
  Object.defineProperty(popup, 'scrollHeight', { configurable: true, value: 1000 });
};

// The pointer coming over the menu makes the overlay scrollbar measure it and show its thumb.
const hoverMenu = async (popup: HTMLElement) => {
  await act(async () => {
    popup.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await dom.happyDOM.waitUntilComplete();
  });
  const thumb = popup.parentElement!.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
  expect(thumb?.hidden).toBe(false);
};

// The press sequence a mouse drag on the overlay thumb produces in a browser. The thumb is not
// focusable, so the browser's default action for mousedown moves focus out of the menu.
const dragThumb = async (popup: HTMLElement) => {
  const thumb = popup.parentElement!.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
  expect(thumb !== null).toBe(true);
  const pointer = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', button: 0 };
  await act(async () => {
    thumb!.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientY: 10 }));
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 10 });
    thumb!.dispatchEvent(mouseDown);
    if (!mouseDown.defaultPrevented && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    thumb!.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientY: 400 }));
    thumb!.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientY: 400 }));
    thumb!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientY: 400 }));
    thumb!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientY: 400 }));
    await dom.happyDOM.waitUntilComplete();
  });
};

const pressOutside = async () => {
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, pointerType: 'mouse' }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, pointerType: 'mouse' }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

test('dragging a short dropdown menu\'s scrollbar scrolls it without closing it, and an outside click still does', async () => {
  const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } = menus;
  await act(async () => root.render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Display</DropdownMenuTrigger>
      <DropdownMenuContent>
        {Array.from({ length: 30 }, (_, index) => <DropdownMenuItem key={index}>Item {index}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>,
  ));
  const popup = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
  expect(popup !== null).toBe(true);
  expect(getComputedStyle(popup!).overflowY === 'auto' || popup!.classList.contains('overflow-y-auto')).toBe(true);
  makeScrollable(popup!);
  await hoverMenu(popup!);

  const focused = document.activeElement;
  expect(popup!.contains(focused)).toBe(true);
  await dragThumb(popup!);
  // The press on the thumb leaves keyboard focus in the menu, so arrow keys keep working.
  expect(document.activeElement === focused).toBe(true);
  expect(document.querySelector('[data-slot="dropdown-menu-content"]') === popup).toBe(true);
  expect(popup!.scrollTop > 0).toBe(true);

  await pressOutside();
  expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
});

test('dragging a context submenu\'s scrollbar keeps the submenu and its menu open, and an outside click closes them', async () => {
  const { ContextMenu, ContextMenuContent, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuItem } = await import('./context-menu');
  await act(async () => root.render(
    <ContextMenu defaultOpen>
      <ContextMenuContent>
        <ContextMenuSub defaultOpen>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {Array.from({ length: 30 }, (_, index) => <ContextMenuItem key={index}>Item {index}</ContextMenuItem>)}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>,
  ));
  // A context menu ignores outside presses for a moment after it opens, so a long press cannot close it.
  await act(async () => { await dom.happyDOM.waitUntilComplete(); });
  const submenu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]');
  expect(submenu !== null).toBe(true);
  makeScrollable(submenu!);
  await hoverMenu(submenu!);
  // A user who moved into the submenu has focus on one of its items.
  await act(async () => { submenu!.querySelector<HTMLElement>('[role="menuitem"]')!.focus(); });

  const focused = document.activeElement;
  expect(submenu!.contains(focused)).toBe(true);
  await dragThumb(submenu!);
  // The press on the thumb leaves keyboard focus in the menu, so arrow keys keep working.
  expect(document.activeElement === focused).toBe(true);
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]') === submenu).toBe(true);
  expect(document.querySelector('[data-slot="dropdown-menu-content"]') !== null).toBe(true);
  expect(submenu!.scrollTop > 0).toBe(true);

  await pressOutside();
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]') === null).toBe(true);
  expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
});

test('a context submenu gives the caller ref and the overlay scrollbar the popup in the same commit, and runs the caller cleanup on close', async () => {
  const { ContextMenu, ContextMenuContent, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuItem } = await import('./context-menu');
  const calls: Array<HTMLElement | null | 'cleanup'> = [];
  const callerRef = (node: HTMLDivElement | null) => {
    calls.push(node);
    return () => { calls.push('cleanup'); };
  };
  const Menu = ({ subOpen }: { subOpen: boolean }) => (
    <ContextMenu defaultOpen>
      <ContextMenuContent>
        <ContextMenuSub open={subOpen}>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent ref={callerRef}>
            <ContextMenuItem>One</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
  await act(async () => root.render(<Menu subOpen />));
  const popup = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]');
  expect(popup !== null).toBe(true);
  // One call with the mounted node: no null first, no second commit to deliver it.
  expect(calls.length).toBe(1);
  expect(calls[0] === popup).toBe(true);
  // PopupOverlayScrollbar sizes its frame from the scroller; without one the frame keeps no inline size.
  const frame = popup!.parentElement!.querySelector('.pointer-events-none.absolute');
  expect(frame?.getAttribute('style') ?? '').toContain('width');

  await act(async () => root.render(<Menu subOpen={false} />));
  await act(async () => { await dom.happyDOM.waitUntilComplete(); });
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]') === null).toBe(true);
  expect(calls.slice(1)).toEqual(['cleanup']);
});
