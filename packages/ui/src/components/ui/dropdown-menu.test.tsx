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
    getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
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
