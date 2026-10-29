import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let dom: Window;
let root: Root;
let Picker: typeof import('./NewWorktreeBranchPicker').NewWorktreeBranchPicker;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent, FocusEvent: dom.FocusEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // happy-dom has no layout. Give the real virtualizer a viewport and row sizes.
  Object.defineProperties(dom.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 300 },
    clientWidth: { configurable: true, get: () => 320 },
    offsetHeight: { configurable: true, get() { return this.classList.contains('overlay-scrollbar-target') ? 300 : 32; } },
    offsetWidth: { configurable: true, get: () => 320 },
  });
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    return new dom.DOMRect(0, 0, 320, this.classList.contains('overlay-scrollbar-target') ? 300 : 32);
  };
  dom.HTMLElement.prototype.scrollIntoView = () => undefined;
  ({ NewWorktreeBranchPicker: Picker } = await import('./NewWorktreeBranchPicker'));
  ({ I18nProvider } = await import('@/lib/i18n'));
  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.abort();
  dom.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const mount = async (count: number, isMobile = false) => {
  let selected = '';
  await act(async () => root.render(
    <I18nProvider>
      <Picker
        value="" placeholder="Based on" title="Select branch"
        localBranches={['main']}
        remoteBranches={Array.from({ length: count }, (_, index) => `origin/branch-${String(index).padStart(5, '0')}`)}
        isLoading={false} isMobile={isMobile}
        onSelect={(branch) => { selected = branch.value; }}
      />
    </I18nProvider>,
  ));
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
  return () => selected;
};

const key = async (key: string, ctrlKey = false) => {
  await act(async () => {
    document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
  });
};

const search = async (value: string) => {
  await act(async () => {
    const input = document.querySelector('input')!;
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

test('50,000 branches mount a bounded desktop window and remain reachable by keyboard', async () => {
  const selection = await mount(50_000);
  expect(document.querySelectorAll('[cmdk-item]').length).toBeGreaterThan(1);
  expect(document.querySelectorAll('[cmdk-item]').length).toBeLessThan(80);
  await key('End');
  expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toBe('origin/branch-49999');
  await key('p', true);
  expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toBe('origin/branch-49998');
  await key('n', true);
  const active = document.querySelector('[cmdk-item][aria-selected="true"]');
  expect(document.querySelector('input')?.getAttribute('aria-activedescendant')).toBe(active?.id);
  await key('Home');
  expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toBe('main');
  for (let index = 0; index < 45; index++) await key('ArrowDown');
  expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toBe('origin/branch-00044');
  await key('End');
  await key('Enter');
  expect(selection()).toBe('remotes/origin/branch-49999');
});

test('50,000 mobile branches mount a bounded window', async () => {
  await mount(50_000, true);
  const buttons = document.querySelectorAll('[role="dialog"] button');
  expect(buttons.length).toBeGreaterThan(2);
  expect(buttons.length).toBeLessThan(80);
});

test('filtering between virtual, empty and short lists preserves selection and clears on reopen', async () => {
  const selection = await mount(100);
  await search('absent imaginary');
  expect(document.querySelectorAll('[cmdk-item]').length).toBe(0);
  await search('main');
  await key('Enter');
  expect(selection()).toBe('main');
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
  expect(document.querySelector('input')?.value).toBe('');
  expect(document.querySelectorAll('[cmdk-item]').length).toBeGreaterThan(1);
  expect(document.querySelectorAll('[cmdk-item]').length).toBeLessThan(80);
  await key('End');
  await key('Enter');
  expect(selection()).toBe('remotes/origin/branch-00099');
});

test('Escape dismisses the picker from its search input', async () => {
  await mount(100);
  await key('Escape');
  expect(document.querySelector('[cmdk-root]') === null).toBe(true);
});

for (const count of [39, 40, 41]) {
  test(`branch selection works with ${count} remote branches around the virtualization threshold`, async () => {
    const selection = await mount(count);
    await key('End');
    await key('ArrowUp');
    await key('ArrowDown');
    await key('Enter');
    expect(selection()).toBe(`remotes/origin/branch-${String(count - 1).padStart(5, '0')}`);
  });
}
