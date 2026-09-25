import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionPage } from '@/lib/opencode/client';
import {
  GLOBAL_SESSIONS_REFRESH_INTERVAL_MS,
  startGlobalSessionsPolling,
  useGlobalSessionsPolling,
} from './useGlobalSessionsPolling';

const flush = async () => { await new Promise<void>((resolve) => queueMicrotask(resolve)); };
const timers = () => {
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    schedule: (callback: () => void, delay: number) => {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clear: (id: number) => { pending.delete(id); },
    fire: async () => {
      expect(pending.size).toBe(1);
      const entry = pending.entries().next().value;
      if (!entry) throw new Error('No scheduled refresh');
      pending.delete(entry[0]);
      entry[1].callback();
      await flush();
    },
    delay: () => [...pending.values()][0]?.delay,
  };
};

describe('global sessions polling lifecycle', () => {
  test('loads immediately, schedules only after completion, and clears its timer on disposal', async () => {
    const clock = timers();
    let initialLoads = 0;
    let refreshes = 0;
    let complete: (success: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => { complete = resolve; });
    const dispose = startGlobalSessionsPolling(
      () => { initialLoads += 1; return pending; },
      async () => { refreshes += 1; return true; },
      clock.schedule, clock.clear,
    );
    expect(initialLoads).toBe(1);
    expect(clock.pending.size).toBe(0);
    complete(true);
    await flush();
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    await clock.fire();
    expect(refreshes).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    dispose();
    expect(clock.pending.size).toBe(0);
  });

  test('recovers a startup failure without waiting 45 seconds or user interaction', async () => {
    const clock = timers();
    let calls = 0;
    const dispose = startGlobalSessionsPolling(
      async () => false,
      async () => { calls += 1; return true; },
      clock.schedule, clock.clear,
    );
    await flush();
    expect(clock.delay()).toBe(1_000);
    await clock.fire();
    expect(calls).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('bounds startup retries and resumes ordinary polling after exhaustion', async () => {
    const clock = timers();
    const fail = async () => false;
    const dispose = startGlobalSessionsPolling(fail, fail, clock.schedule, clock.clear);
    await flush();
    for (const delay of [1_000, 2_000, 4_000, GLOBAL_SESSIONS_REFRESH_INTERVAL_MS]) {
      expect(clock.delay()).toBe(delay);
      await clock.fire();
    }
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('a background failure after success does not restart the startup retry burst', async () => {
    const clock = timers();
    const dispose = startGlobalSessionsPolling(async () => true, async () => false, clock.schedule, clock.clear);
    await flush();
    await clock.fire();
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('a rejected load remains recoverable', async () => {
    const clock = timers();
    const dispose = startGlobalSessionsPolling(
      async () => { throw new Error('offline'); }, async () => true, clock.schedule, clock.clear,
    );
    await flush();
    expect(clock.delay()).toBe(1_000);
    await clock.fire();
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('disposal during a load prevents a late completion from scheduling more work', async () => {
    const clock = timers();
    let complete: (success: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => { complete = resolve; });
    const dispose = startGlobalSessionsPolling(() => pending, async () => true, clock.schedule, clock.clear);
    dispose();
    complete(false);
    await flush();
    expect(clock.pending.size).toBe(0);
  });
});

test('the mounted poller recovers real store failure and starts a fresh load on runtime switch', async () => {
  const dom = new Window({ url: 'http://sessions.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
  const home = spyOn(opencodeClient, 'getFilesystemHomeInfo')
    .mockRejectedValueOnce(new Error('startup unavailable'))
    .mockResolvedValue({ home: '/home/user', chatsRoot: '/chats' });
  const host = spyOn(opencodeClient, 'getHostSessionStatusSnapshot').mockResolvedValue(null);
  const session = (id: string): SessionPage => ({ sessions: [{
    id, projectID: 'project', directory: '/project', title: id,
    time: { created: 1, updated: 2 },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }], cursor: {} });
  const list = spyOn(opencodeClient, 'listSessionsPage').mockResolvedValue(session('restored'));
  const clock = timers();
  // happy-dom returns Node timer handles; retain that contract while controlling time.
  const originalTimeout = dom.setTimeout.bind(dom);
  const originalClear = dom.clearTimeout.bind(dom);
  const handles = new Map<ReturnType<typeof dom.setTimeout>, number>();
  const timeout = spyOn(dom, 'setTimeout').mockImplementation((callback, delay) => {
    const handle = originalTimeout(() => undefined, 0);
    originalClear(handle);
    handles.set(handle, clock.schedule(() => callback(), delay ?? 0));
    return handle;
  });
  const clear = spyOn(dom, 'clearTimeout').mockImplementation((handle) => {
    const id = handle === undefined ? undefined : handles.get(handle);
    if (id !== undefined) clock.clear(id);
  });
  // The app resets the store before the poller's endpoint listener runs.
  const reset = subscribeRuntimeEndpointChanged(() => useGlobalSessionsStore.getState().resetForRuntimeSwitch());
  switchRuntimeEndpoint({ apiBaseUrl: 'http://sessions.test', runtimeKey: 'startup-a' });
  const root = createRoot(document.createElement('div'));
  const Harness = ({ enabled }: { enabled: boolean }) => { useGlobalSessionsPolling(enabled); return null; };
  let resolveOldPage: (page: SessionPage) => void = () => undefined;
  try {
    await act(async () => root.render(React.createElement(Harness, { enabled: false })));
    expect(home.mock.calls.length).toBe(0);
    await act(async () => root.render(React.createElement(Harness, { enabled: true })));
    expect(useGlobalSessionsStore.getState().status).toBe('error');
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
    expect(clock.delay()).toBe(1_000);
    await act(async () => clock.fire());
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['restored']);
    expect(useGlobalSessionsStore.getState().status).toBe('ready');
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
    expect(list.mock.calls.every(([options]) => options?.global === true)).toBe(true);

    const oldPage = new Promise<SessionPage>((resolve) => { resolveOldPage = resolve; });
    list.mockImplementationOnce(() => oldPage);
    await act(async () => clock.fire());
    expect(useGlobalSessionsStore.getState().status).toBe('loading');
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(true);
    expect(clock.pending.size).toBe(0);
    list.mockResolvedValue(session('new-runtime'));
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://sessions.test', runtimeKey: 'startup-b' }));
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['new-runtime']);
    expect(clock.pending.size).toBe(1);
    const seedsBeforeOldCompletion = host.mock.calls.length;
    await act(async () => resolveOldPage(session('stale')));
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['new-runtime']);
    expect(host.mock.calls.length).toBe(seedsBeforeOldCompletion);
    expect(clock.pending.size).toBe(1);
    // The app may reset stores when the endpoint changes but runtime identity stays the same.
    list.mockResolvedValue(session('reconnected'));
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://reconnected.test', runtimeKey: 'startup-b' }));
    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(['reconnected']);
    expect(clock.pending.size).toBe(1);
    await act(async () => root.render(React.createElement(Harness, { enabled: false })));
    expect(clock.pending.size).toBe(0);
  } finally {
    resolveOldPage({ sessions: [], cursor: {} });
    await act(async () => root.unmount());
    reset();
    for (const spy of [fetch, home, host, list, timeout, clear]) spy.mockRestore();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
