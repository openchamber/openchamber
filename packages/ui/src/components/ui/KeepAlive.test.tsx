import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { KeepAlive } from './KeepAlive';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let host: HTMLDivElement;
let root: Root;
const session = React.createContext('outside');
const connected = new Set<string>();
let instances = 0;

function Content({ name, text }: { name: string; text: string }) {
  const identity = React.useContext(session);
  const [instance] = React.useState(() => ++instances);
  React.useEffect(() => {
    connected.add(name);
    return () => {
      connected.delete(name);
    };
  }, [name]);
  return (
    <section data-session={name} data-instance={instance} data-context={identity}>
      <input defaultValue={name} />
      <span>{text}</span>
    </section>
  );
}

const render = (name: string | null, text = name ?? '', capacity = 4) => act(async () => {
  root.render(
    <session.Provider value={name ?? 'empty'}>
      <KeepAlive cacheKey={name} capacity={capacity}>
        <session.Provider value={name ?? ''}>
          <Content name={name ?? ''} text={text} />
        </session.Provider>
      </KeepAlive>
    </session.Provider>,
  );
});

beforeEach(() => {
  instances = 0;
  connected.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('retains DOM and state, reconnects effects and uses the latest current input', async () => {
  await render('A');
  const a = host.querySelector('[data-session="A"]');
  const input = a?.querySelector('input');
  if (!input) throw new Error('Missing input');
  input.value = 'draft';
  await render('B');
  expect(connected).toEqual(new Set(['B']));
  expect(a?.getAttribute('data-context')).toBe('A');
  await render('A', 'updated');
  expect(host.querySelector('[data-session="A"]')).toBe(a);
  expect(input.value).toBe('draft');
  expect(a?.querySelector('span')?.textContent).toBe('updated');
  expect(connected).toEqual(new Set(['A']));
  expect(instances).toBe(2);
});

test('evicts the least recently visited entry, includes active in capacity, and remounts evicted entries', async () => {
  for (const name of ['A', 'B', 'C', 'D']) {
    await render(name);
  }
  const a = host.querySelector('[data-session="A"]');
  const b = host.querySelector('[data-session="B"]');
  await render('A');
  await render('E');
  expect(host.querySelectorAll('section').length).toBe(4);
  expect(a?.isConnected).toBe(true);
  expect(b?.isConnected).toBe(false);
  await render('B');
  expect(host.querySelector('[data-session="B"]')).not.toBe(b);
  expect(connected).toEqual(new Set(['B']));
});

test('an empty foreground hides retained entries without replacing them', async () => {
  await render('A');
  const a = host.querySelector('[data-session="A"]');
  await render(null);
  expect(connected.size).toBe(0);
  expect(a?.isConnected).toBe(true);
  await render('A');
  expect(host.querySelector('[data-session="A"]')).toBe(a);
});

test('promoting an entry does not reorder retained DOM', async () => {
  await render('A');
  await render('B');
  const before = [...host.querySelectorAll('section')];

  await render('A');

  expect([...host.querySelectorAll('section')]).toEqual(before);
});

test('an abandoned suspended switch does not evict a committed entry', async () => {
  await render('A', 'A', 1);
  const a = host.querySelector('[data-session="A"]');
  const pending = new Promise<never>(() => {});
  function Pending() {
    React.use(pending);
    return null;
  }
  await act(async () => {
    React.startTransition(() => root.render(
      <session.Provider value="changing-parent">
        <KeepAlive cacheKey="B" capacity={1}>
          <Pending />
        </KeepAlive>
      </session.Provider>,
    ));
  });
  // Interrupt before the pending transition commits.
  await render('A', 'latest', 1);
  expect(host.querySelector('[data-session="A"]')).toBe(a);
  expect(a?.querySelector('span')?.textContent).toBe('latest');
});
