import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useShownAfter } from './useShownAfter';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Probe: React.FC<{ active: boolean }> = ({ active }) => (
  <span data-id="probe">{useShownAfter(active, 300) ? 'shown' : 'hidden'}</span>
);

const text = () => host.querySelector('[data-id="probe"]')?.textContent ?? null;
const render = (element: React.ReactElement) => act(async () => root?.render(element));
const advance = (milliseconds: number) => act(async () => {
  jest.advanceTimersByTime(milliseconds);
});

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  jest.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  jest.useRealTimers();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('a wait that ends within the delay never shows', async () => {
  await render(<Probe active />);
  expect(text()).toBe('hidden');
  await advance(299);
  expect(text()).toBe('hidden');
  await render(<Probe active={false} />);
  await advance(300);
  expect(text()).toBe('hidden');
});

test('a wait that outlasts the delay shows, and hides the moment it ends', async () => {
  await render(<Probe active />);
  await advance(300);
  expect(text()).toBe('shown');
  await render(<Probe active={false} />);
  expect(text()).toBe('hidden');
});
