import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useReconnectStuck } from './useReconnectStuck';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const render = (element: React.ReactElement) => act(async () => root?.render(element));

const advance = (milliseconds: number) => act(async () => {
  jest.advanceTimersByTime(milliseconds);
});

const now = () => Date.now();

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

const StuckProbe: React.FC<{
  isReconnecting: boolean;
  updatedAtMs: number | null;
}> = ({ isReconnecting, updatedAtMs }) => {
  const stuck = useReconnectStuck(isReconnecting, updatedAtMs);
  return <span data-id="stuck">{String(stuck)}</span>;
};

const stuckValue = () => host.querySelector('[data-id="stuck"]')?.textContent;

test('not reconnecting: stuck stays false', async () => {
  await render(<StuckProbe isReconnecting={false} updatedAtMs={now()} />);
  expect(stuckValue()).toBe('false');
});

test('no updatedAtMs: stuck stays false', async () => {
  await render(<StuckProbe isReconnecting={true} updatedAtMs={null} />);
  expect(stuckValue()).toBe('false');
});

test('threshold not reached before 12s', async () => {
  await render(<StuckProbe isReconnecting={true} updatedAtMs={now()} />);
  expect(stuckValue()).toBe('false');
  await advance(11_000);
  expect(stuckValue()).toBe('false');
});

test('threshold reached at 12s: stuck becomes true at deadline', async () => {
  const t = now();
  await render(<StuckProbe isReconnecting={true} updatedAtMs={t} />);
  expect(stuckValue()).toBe('false');

  // At exactly t + 12_000, the one-shot timer fires and sets stuck to true
  await advance(12_000);
  expect(stuckValue()).toBe('true');
});

test('already past threshold: stuck immediately true', async () => {
  await render(<StuckProbe isReconnecting={true} updatedAtMs={now() - 15_000} />);
  expect(stuckValue()).toBe('true');
});

test('updatedAtMs change reschedules the timer', async () => {
  const setTimeoutSpy = spyOn(window, 'setTimeout');
  const clearTimeoutSpy = spyOn(window, 'clearTimeout');

  const t = now();
  await render(<StuckProbe isReconnecting={true} updatedAtMs={t} />);
  expect(stuckValue()).toBe('false');
  expect(setTimeoutSpy.mock.calls.length).toBe(1);

  clearTimeoutSpy.mockRestore();
  setTimeoutSpy.mockRestore();
  const setTimeoutSpy2 = spyOn(window, 'setTimeout');
  const clearTimeoutSpy2 = spyOn(window, 'clearTimeout');

  // Re-render with a new updatedAtMs: old timer cleared, new timer set
  await render(<StuckProbe isReconnecting={true} updatedAtMs={t + 5_000} />);
  expect(stuckValue()).toBe('false');
  expect(clearTimeoutSpy2.mock.calls.length).toBe(1);
  expect(setTimeoutSpy2.mock.calls.length).toBe(1);

  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  setTimeoutSpy2.mockRestore();
  clearTimeoutSpy2.mockRestore();
});

test('phase change cancels the timer', async () => {
  const clearTimeoutSpy = spyOn(window, 'clearTimeout');

  await render(<StuckProbe isReconnecting={true} updatedAtMs={now()} />);
  expect(clearTimeoutSpy.mock.calls.length).toBe(0);

  clearTimeoutSpy.mockRestore();
  const clearTimeoutSpy2 = spyOn(window, 'clearTimeout');

  // Change to not reconnecting: timer cleared
  await render(<StuckProbe isReconnecting={false} updatedAtMs={now()} />);
  expect(stuckValue()).toBe('false');
  expect(clearTimeoutSpy2.mock.calls.length).toBe(1);

  clearTimeoutSpy.mockRestore();
  clearTimeoutSpy2.mockRestore();
});
