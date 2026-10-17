import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTunnelClock } from './useTunnelClock';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>;

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

const ClockProbe: React.FC<{
  tunnelInfo: { bootstrapExpiresAt: number | null } | null;
  sessionRecords: { status: 'active' | 'inactive'; expiresAt: number }[];
}> = ({ tunnelInfo, sessionRecords }) => {
  const [nowTs, clockActive] = useTunnelClock(tunnelInfo, sessionRecords);
  return (
    <>
      <span data-id="clock-active">{String(clockActive)}</span>
      <span data-id="now">{String(nowTs)}</span>
    </>
  );
};

const clockActive = () => host.querySelector('[data-id="clock-active"]')?.textContent;

test('inactive-only history: no running clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');

  await render(
    <ClockProbe
      tunnelInfo={null}
      sessionRecords={[
        { status: 'inactive', expiresAt: now() - 1000 },
        { status: 'inactive', expiresAt: now() - 5000 },
      ]}
    />
  );

  // Optimistic starts false (no bootstrap, no active records), so no subscription
  expect(setIntervalSpy.mock.calls.length).toBe(0);
  expect(clockActive()).toBe('false');

  setIntervalSpy.mockRestore();
});

test('active future expiry: clock running', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');

  await render(
    <ClockProbe
      tunnelInfo={null}
      sessionRecords={[
        { status: 'active', expiresAt: now() + 60_000 },
      ]}
    />
  );

  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  expect(clockActive()).toBe('true');

  setIntervalSpy.mockRestore();
});

test('clock stops after active session expires', async () => {
  const expiresAt = now() + 2000;
  const setIntervalSpy = spyOn(window, 'setInterval');
  const clearIntervalSpy = spyOn(window, 'clearInterval');

  await render(
    <ClockProbe
      tunnelInfo={null}
      sessionRecords={[
        { status: 'active', expiresAt },
      ]}
    />
  );

  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  expect(clockActive()).toBe('true');

  clearIntervalSpy.mockRestore();
  const setIntervalSpy2 = spyOn(window, 'setInterval');
  const clearIntervalSpy2 = spyOn(window, 'clearInterval');

  // Advance past expiry: tick updates nowTs, actual becomes false, clock stops
  await advance(2500);

  expect(clearIntervalSpy2.mock.calls.length).toBeGreaterThan(0);
  expect(clockActive()).toBe('false');

  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
  setIntervalSpy2.mockRestore();
  clearIntervalSpy2.mockRestore();
});

test('bootstrap expiry in the future: clock running', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');

  await render(
    <ClockProbe
      tunnelInfo={{ bootstrapExpiresAt: now() + 60_000 }}
      sessionRecords={[]}
    />
  );

  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  expect(clockActive()).toBe('true');

  setIntervalSpy.mockRestore();
});

test('bootstrap expired: no running clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');

  await render(
    <ClockProbe
      tunnelInfo={{ bootstrapExpiresAt: now() - 1000 }}
      sessionRecords={[]}
    />
  );

  // Optimistic starts true (non-null bootstrapExpiresAt) but after first tick
  // actual becomes false and clock stops
  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  expect(clockActive()).toBe('false');

  setIntervalSpy.mockRestore();
});

test('restart after clock stopped: new future expiry restarts clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');

  // Start with expired bootstrap: clock stops after first tick
  await render(
    <ClockProbe
      tunnelInfo={{ bootstrapExpiresAt: now() - 1000 }}
      sessionRecords={[]}
    />
  );
  expect(clockActive()).toBe('false');

  // New future bootstrap: clock restarts
  await render(
    <ClockProbe
      tunnelInfo={{ bootstrapExpiresAt: now() + 60_000 }}
      sessionRecords={[]}
    />
  );

  expect(clockActive()).toBe('true');
  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);

  setIntervalSpy.mockRestore();
});
