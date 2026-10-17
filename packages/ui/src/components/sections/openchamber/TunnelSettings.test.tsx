import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDurationTickerNow } from '@/hooks/useDurationTicker';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

type TunnelMode = 'quick' | 'managed-remote' | 'managed-local';

interface TunnelInfo {
  url: string;
  connectUrl: string | null;
  bootstrapExpiresAt: number | null;
}

interface TunnelSessionRecord {
  sessionId: string;
  mode: TunnelMode | null;
  status: 'active' | 'inactive';
  inactiveReason?: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  publicUrl?: string | null;
}

const ClockGatingProbe: React.FC<{
  tunnelInfo?: TunnelInfo | null;
  sessionRecords?: TunnelSessionRecord[];
}> = ({ tunnelInfo = null, sessionRecords = [] }) => {
  // Exact clock gating pattern from TunnelSettings.tsx (lines 386-395)
  const clockShouldRunOptimistic = Boolean(tunnelInfo?.bootstrapExpiresAt) || sessionRecords.some((r) => r.status === 'active');
  const [clockActive, setClockActive] = React.useState(clockShouldRunOptimistic);
  const nowTs = useDurationTickerNow(clockActive);
  const clockShouldRunActual = (tunnelInfo?.bootstrapExpiresAt != null && tunnelInfo.bootstrapExpiresAt > nowTs)
    || sessionRecords.some((r) => r.status === 'active' && r.expiresAt > nowTs);
  React.useEffect(() => {
    if (clockShouldRunActual !== clockActive) {
      setClockActive(clockShouldRunActual);
    }
  }, [clockShouldRunActual, clockActive]);

  return <span data-id="now">{nowTs}</span>;
};

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

test('inactive-only history does not subscribe to the clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');
  await render(
    <ClockGatingProbe
      sessionRecords={[{
        sessionId: 's1',
        mode: 'quick',
        status: 'inactive',
        inactiveReason: 'expired',
        createdAt: Date.now() - 10000,
        lastSeenAt: Date.now() - 5000,
        expiresAt: Date.now() - 1000,
      }]}
    />
  );
  expect(setIntervalSpy.mock.calls.length).toBe(0);
  setIntervalSpy.mockRestore();
});

test('active future expiry subscribes to the clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');
  await render(
    <ClockGatingProbe
      sessionRecords={[{
        sessionId: 's1',
        mode: 'quick',
        status: 'active',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }]}
    />
  );
  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  setIntervalSpy.mockRestore();
});

test('clock stops after active session expires', async () => {
  const expiresAt = Date.now() + 2000;
  const setIntervalSpy = spyOn(window, 'setInterval');
  let clearIntervalSpy = spyOn(window, 'clearInterval');

  await render(
    <ClockGatingProbe
      sessionRecords={[{
        sessionId: 's1',
        mode: 'quick',
        status: 'active',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt,
      }]}
    />
  );
  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  expect(clearIntervalSpy.mock.calls.length).toBe(0);

  clearIntervalSpy.mockRestore();
  clearIntervalSpy = spyOn(window, 'clearInterval');

  // Advance past the expiry — the tick updates nowTs, clockShouldRunActual
  // becomes false, the effect sets clockActive to false, and the cleanup
  // unsubscribes (calling clearInterval).
  await advance(2500);

  expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(0);

  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
});

test('bootstrap expiry in the future subscribes to the clock', async () => {
  const setIntervalSpy = spyOn(window, 'setInterval');
  await render(
    <ClockGatingProbe
      tunnelInfo={{
        url: 'https://example.com',
        connectUrl: 'wss://example.com',
        bootstrapExpiresAt: Date.now() + 60_000,
      }}
      sessionRecords={[]}
    />
  );
  expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  setIntervalSpy.mockRestore();
});

test('bootstrap expired stops the clock', async () => {
  const clearIntervalSpy = spyOn(window, 'clearInterval');
  await render(
    <ClockGatingProbe
      tunnelInfo={{
        url: 'https://example.com',
        connectUrl: 'wss://example.com',
        bootstrapExpiresAt: Date.now() - 1000,
      }}
      sessionRecords={[]}
    />
  );
  // The clock starts optimistically (Boolean of a non-zero timestamp) but
  // stops after the effect runs and sees clockShouldRunActual is false.
  expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(0);
  clearIntervalSpy.mockRestore();
});
