import { expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let useSessionSearchEffects: typeof import('./useSessionSearchEffects')['useSessionSearchEffects'];

const withDom = async (run: (host: HTMLElement, root: Root) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    FocusEvent: dom.FocusEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const host = document.createElement('div');
  document.body.append(host);
  ({ useSessionSearchEffects } = await import('./useSessionSearchEffects'));
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  try {
    await run(host, root);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

function Harness({ enabled }: { enabled?: boolean }) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  useSessionSearchEffects({ enabled, sessionSearchInputRef: inputRef });
  return <>
    <button type="button" data-elsewhere>Elsewhere</button>
    <input ref={inputRef} data-search-field defaultValue="token" />
  </>;
}

const requestSearch = () => act(async () => {
  window.dispatchEvent(new CustomEvent('openchamber:sidebar-session-search'));
});
const field = (host: HTMLElement) => host.querySelector<HTMLInputElement>('[data-search-field]')!;
const focusElsewhere = (host: HTMLElement) => act(async () => host.querySelector<HTMLButtonElement>('[data-elsewhere]')!.focus());

test('the shortcut puts the caret in the search field and selects what is typed there', () => withDom(async (host, root) => {
  await act(async () => root.render(<Harness />));
  await focusElsewhere(host);
  expect(document.activeElement).not.toBe(field(host));

  await requestSearch();

  expect(document.activeElement).toBe(field(host));
  expect([field(host).selectionStart, field(host).selectionEnd]).toEqual([0, 'token'.length]);
}));

test('a sidebar that is not shown leaves the focus where it is', () => withDom(async (host, root) => {
  await act(async () => root.render(<Harness enabled={false} />));
  await focusElsewhere(host);

  await requestSearch();

  expect(document.activeElement).toBe(host.querySelector('[data-elsewhere]'));
}));

test('hiding the sidebar and unmounting it both stop answering the shortcut', () => withDom(async (host, root) => {
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<Harness enabled={false} />));
  await focusElsewhere(host);
  await requestSearch();
  expect(document.activeElement).toBe(host.querySelector('[data-elsewhere]'));

  await act(async () => root.render(<Harness />));
  const mounted = field(host);
  let focused = 0;
  mounted.addEventListener('focus', () => { focused += 1; });
  await act(async () => root.render(null));
  await requestSearch();
  expect(focused).toBe(0);
}));
