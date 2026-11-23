import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type AppListener = (state?: { isActive: boolean }) => void;
type PendingPing = { signal: AbortSignal; answer: (ok: boolean) => void };

const appListeners = new Map<string, AppListener>();
let pings: PendingPing[] = [];

mock.module('@capacitor/app', () => ({
  App: {
    addListener: async (event: string, listener: AppListener) => {
      appListeners.set(event, listener);
      return { remove: async () => { appListeners.delete(event); } };
    },
    getState: async () => ({ isActive: true }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (_input: string, init: { signal: AbortSignal }) => new Promise<Response>((resolve) => {
    pings.push({ signal: init.signal, answer: (ok) => resolve(new Response('', { status: ok ? 200 : 503 })) });
  }),
}));

const { I18nProvider } = await import('@/lib/i18n');
const { MobileConnectionHeartbeat } = await import('./MobileConnectionHeartbeat');

const PING_INTERVAL_MS = 4_000;

type Timer = { callback: () => void; delay: number };
let timers: Map<number, Timer>;
let intervals: Set<number>;
let root: Root | null = null;
let host: HTMLElement;

const installFakeTimers = (dom: Window) => {
  let nextId = 1;
  timers = new Map();
  intervals = new Set();
  Object.assign(dom, {
    setTimeout: (callback: () => void, delay = 0) => {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id?: number) => { if (id !== undefined) timers.delete(id); },
    setInterval: () => {
      const id = nextId++;
      intervals.add(id);
      return id;
    },
    clearInterval: (id?: number) => { if (id !== undefined) intervals.delete(id); },
  });
};

const pendingPingTimers = () => [...timers.values()].filter((timer) => timer.delay === PING_INTERVAL_MS);

const fireNextPing = () => act(async () => {
  const [id, timer] = [...timers.entries()].find(([, entry]) => entry.delay === PING_INTERVAL_MS) ?? [];
  if (id === undefined || !timer) throw new Error('no ping is scheduled');
  timers.delete(id);
  timer.callback();
});

const flush = () => act(async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
});

const setNativeActive = (isActive: boolean) => act(async () => {
  appListeners.get('appStateChange')?.({ isActive });
});

const answerLatest = (ok = true) => act(async () => {
  pings.at(-1)?.answer(ok);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
});

const mount = async () => {
  await act(async () => root?.render(<I18nProvider><MobileConnectionHeartbeat status="Connected" /></I18nProvider>));
  await flush();
};

beforeEach(() => {
  appListeners.clear();
  pings = [];
  const dom = new Window({ url: 'http://localhost' });
  installFakeTimers(dom);
  Object.defineProperty(dom, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: dom.navigator });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  // The WebView keeps reporting visible while the native app is in the background.
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'navigator');
});

describe('MobileConnectionHeartbeat lifecycle', () => {
  test('native background stops pinging while the page stays visible, and resume pings afresh', async () => {
    await mount();
    expect(pings).toHaveLength(1);
    expect(intervals.size).toBe(1);
    await answerLatest();
    expect(host.textContent).toContain('ms');
    expect(pendingPingTimers()).toHaveLength(1);

    await fireNextPing();
    expect(pings).toHaveLength(2);
    const inFlight = pings[1];

    await setNativeActive(false);
    expect(document.visibilityState).toBe('visible');
    expect(inFlight.signal.aborted).toBe(true);
    expect(pendingPingTimers()).toHaveLength(0);
    expect(intervals.size).toBe(0);

    // An answer that lands after the app went to the background changes nothing.
    await answerLatest();
    expect(pendingPingTimers()).toHaveLength(0);
    expect(pings).toHaveLength(2);
    expect(host.textContent).not.toContain('ms');

    await setNativeActive(true);
    expect(pings).toHaveLength(3);
    expect(pings[2].signal.aborted).toBe(false);
    expect(intervals.size).toBe(1);
    // No latency or "No answer" from before the background until the fresh ping answers.
    expect(host.textContent).not.toContain('ms');
    expect(host.textContent).not.toContain('No answer');
  });

  test('backgrounding with only a timer pending cancels it', async () => {
    await mount();
    await answerLatest();
    expect(pendingPingTimers()).toHaveLength(1);

    await setNativeActive(false);
    expect(pendingPingTimers()).toHaveLength(0);
    expect(timers.size).toBe(0);
    expect(intervals.size).toBe(0);
    expect(pings).toHaveLength(1);
  });

  test('unmount with a pending timer clears it and the clock subscription', async () => {
    await mount();
    await answerLatest();
    expect(pendingPingTimers()).toHaveLength(1);

    await act(async () => root?.unmount());
    root = null;
    expect(timers.size).toBe(0);
    expect(intervals.size).toBe(0);
    expect(appListeners.size).toBe(0);
    expect(pings).toHaveLength(1);
  });

  test('unmount with a request in flight aborts it and ignores its late answer', async () => {
    await mount();
    const inFlight = pings[0];
    expect(inFlight.signal.aborted).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    expect(inFlight.signal.aborted).toBe(true);
    expect(intervals.size).toBe(0);

    await answerLatest();
    expect(timers.size).toBe(0);
    expect(pings).toHaveLength(1);
  });
});
