import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

interface Status {
  updatedAtMs: number;
}

const ReconnectStuckProbe: React.FC<{
  isReconnecting: boolean;
  status: Status | null;
}> = ({ isReconnecting, status }) => {
  // Exact effect pattern from RemoteInstancesPage.tsx (lines 1135-1152)
  const [reconnectAppearsStuck, setReconnectAppearsStuck] = React.useState(false);
  React.useEffect(() => {
    if (!isReconnecting || !status) {
      setReconnectAppearsStuck(false);
      return;
    }
    setReconnectAppearsStuck(false);
    const remaining = status.updatedAtMs + 12_000 - Date.now();
    if (remaining <= 0) {
      setReconnectAppearsStuck(true);
      return;
    }
    const timer = window.setTimeout(() => setReconnectAppearsStuck(true), remaining);
    return () => {
      window.clearTimeout(timer);
      setReconnectAppearsStuck(false);
    };
  }, [isReconnecting, status]);

  return <span data-id="stuck">{String(reconnectAppearsStuck)}</span>;
};

const render = (element: React.ReactElement) => act(async () => root?.render(element));

const advance = (milliseconds: number) => act(async () => {
  jest.advanceTimersByTime(milliseconds);
});

const stuckValue = () => host.querySelector('[data-id="stuck"]')?.textContent;

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

test('threshold not reached: reconnectAppearsStuck stays false', async () => {
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');

  await advance(5000);
  expect(stuckValue()).toBe('false');
});

test('threshold reached: reconnectAppearsStuck becomes true after 12s', async () => {
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');

  await advance(12_000);
  expect(stuckValue()).toBe('true');
});

test('updatedAtMs change reschedules the timer', async () => {
  const startTime = Date.now();
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: startTime }}
    />
  );
  expect(stuckValue()).toBe('false');

  // Advance 5s — old timer would fire at startTime + 12s
  await advance(5000);
  expect(stuckValue()).toBe('false');

  // Re-render with updatedAtMs = startTime + 5s (current fake time).
  // Effect cleanup clears the old timer; new effect sets a timer for
  // (startTime + 5s) + 12s = startTime + 17s.
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');

  // Advance to startTime + 12s — old timer must NOT fire (it was cleared)
  await advance(7000);
  expect(stuckValue()).toBe('false');

  // Advance to startTime + 17s — new timer fires
  await advance(5000);
  expect(stuckValue()).toBe('true');
});

test('phase change cancels the timer', async () => {
  let clearTimeoutSpy = spyOn(window, 'clearTimeout');
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');
  expect(clearTimeoutSpy.mock.calls.length).toBe(0);

  clearTimeoutSpy.mockRestore();
  clearTimeoutSpy = spyOn(window, 'clearTimeout');

  // Change to not reconnecting — effect cleanup clears the timer
  await render(
    <ReconnectStuckProbe
      isReconnecting={false}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');
  expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0);

  clearTimeoutSpy.mockRestore();
});

test('unmount cleanup clears the timer', async () => {
  let clearTimeoutSpy = spyOn(window, 'clearTimeout');
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() }}
    />
  );
  expect(stuckValue()).toBe('false');
  expect(clearTimeoutSpy.mock.calls.length).toBe(0);

  clearTimeoutSpy.mockRestore();
  clearTimeoutSpy = spyOn(window, 'clearTimeout');

  // Unmount — effect cleanup clears the timer
  act(() => root?.unmount());
  root = null;

  expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0);

  clearTimeoutSpy.mockRestore();
});

test('already past threshold: reconnectAppearsStuck becomes true immediately', async () => {
  await render(
    <ReconnectStuckProbe
      isReconnecting={true}
      status={{ updatedAtMs: Date.now() - 15_000 }}
    />
  );
  expect(stuckValue()).toBe('true');
});
