import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BusyDots } from './busy-dots';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

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

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

/** The dots as text, a hidden one as a space. */
const shown = () => [...host.querySelectorAll('[data-busy-dots] > span')]
  .map((dot) => (dot.className.includes('invisible') ? ' ' : '.'))
  .join('');

test('the dots fill in one a second, empty from the first, and never all disappear', async () => {
  await act(async () => root?.render(<BusyDots />));
  const seen = [shown()];
  for (let second = 0; second < 5; second += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    seen.push(shown());
  }
  expect(seen).toEqual(['.  ', '.. ', '...', ' ..', '  .', '.  ']);
});
