import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ResolvedStarter } from './useDraftStarters';

let StarterPickerList: typeof import('./DraftStarterPickerList')['StarterPickerList'];
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restoreFetch: () => void;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    SVGElement: dom.SVGElement, Document: dom.Document, ShadowRoot: dom.ShadowRoot,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // Stores the list imports start bootstrap requests; keep them pending.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  restoreFetch = () => fetch.mockRestore();
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ StarterPickerList } = await import('./DraftStarterPickerList'));
  host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  host.remove();
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const starter = (name: string): ResolvedStarter => ({
  id: `global:command:${name}`,
  ref: { type: 'command', name },
  group: 'global',
  label: name,
  icon: 'search',
  submitText: name,
  shared: false,
});

async function mount() {
  const run: string[] = [];
  const remove: string[] = [];
  const front: string[] = [];
  const calls = { run, remove, front };
  const overflow = [starter('first'), starter('second')];
  await act(async () => root.render(
    <I18nProvider>
      <StarterPickerList
        pinnable={[]}
        onPick={() => undefined}
        overflow={overflow}
        actions={{
          onRun: (item) => calls.run.push(item.id),
          onRemove: (item) => calls.remove.push(item.id),
          onToggleShared: () => undefined,
          moveToFrontTarget: (item) => (item.id === overflow[1].id ? overflow[0].id : null),
          onMoveToFront: (item) => calls.front.push(item.id),
        }}
      />
    </I18nProvider>,
  ));
  return { calls, overflow };
}

const button = (label: string, index = 0) => {
  const found = host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index];
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};

// The browser turns Enter and Space on a focused button into its click,
// unless something on the way prevents the default; dispatch the key as a
// browser would and follow it with that click only when it was not prevented.
async function pressOn(target: HTMLButtonElement, key: string) {
  await act(async () => {
    target.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    const notPrevented = target.dispatchEvent(event);
    if (notPrevented) target.click();
  });
}

for (const key of ['Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} on an overflowed starter's Remove removes it and runs nothing`, async () => {
    const { calls, overflow } = await mount();
    await pressOn(button('Remove', 1), key);
    expect(calls.remove).toEqual([overflow[1].id]);
    expect(calls.run).toEqual([]);
  });
}

test('Enter on Move to the front moves that starter and runs nothing', async () => {
  const { calls, overflow } = await mount();
  await pressOn(button('Move to the front'), 'Enter');
  expect(calls.front).toEqual([overflow[1].id]);
  expect(calls.run).toEqual([]);
});

test('Enter on the row itself still runs the highlighted starter', async () => {
  const { calls } = await mount();
  const list = host.querySelector<HTMLElement>('[cmdk-root]');
  if (!list) throw new Error('Missing list');
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(calls.run.length).toBe(1);
  expect(calls.remove).toEqual([]);
});
