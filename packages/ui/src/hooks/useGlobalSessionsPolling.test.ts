import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionPage } from '@/lib/opencode/client';
import { notifyStreamGap } from '@/sync/stream-gap';
import {
  GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS,
  GLOBAL_SESSIONS_RETRY_INTERVAL_MS,
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
    // Before: a 45 s timer, though the event stream already names every new session.
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    await clock.fire();
    expect(refreshes).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    dispose();
    expect(clock.pending.size).toBe(0);
  });

  test('recovers a startup failure without waiting for the full interval or user interaction', async () => {
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
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('bounds startup retries and keeps retrying at the retry interval after exhaustion', async () => {
    const clock = timers();
    const fail = async () => false;
    const dispose = startGlobalSessionsPolling(fail, fail, clock.schedule, clock.clear);
    await flush();
    for (const delay of [1_000, 2_000, 4_000, GLOBAL_SESSIONS_RETRY_INTERVAL_MS]) {
      expect(clock.delay()).toBe(delay);
      await clock.fire();
    }
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_RETRY_INTERVAL_MS);
    dispose();
  });

  test('a background failure after success retries without restarting the startup burst', async () => {
    const clock = timers();
    const dispose = startGlobalSessionsPolling(async () => true, async () => false, clock.schedule, clock.clear);
    await flush();
    await clock.fire();
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_RETRY_INTERVAL_MS);
    dispose();
  });

  test('OpenCode answering ends the wait after a failed startup load', async () => {
    const clock = timers();
    let ready: () => void = () => undefined;
    let refreshes = 0;
    const fail = async () => false;
    const dispose = startGlobalSessionsPolling(
      fail,
      async () => { refreshes += 1; return refreshes > 3; },
      clock.schedule, clock.clear, undefined,
      (listener) => { ready = listener; return () => { ready = () => undefined; }; },
    );
    await flush();
    for (let attempt = 0; attempt < 3; attempt += 1) await clock.fire();
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_RETRY_INTERVAL_MS);
    ready();
    await flush();
    expect(refreshes).toBe(4);
    expect(clock.pending.size).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    // After a success it changes nothing.
    ready();
    await flush();
    expect(refreshes).toBe(4);
    dispose();
  });

  test('OpenCode answering during a failing load runs one more load right after it', async () => {
    const clock = timers();
    let ready: () => void = () => undefined;
    let finishInitial: (success: boolean) => void = () => undefined;
    let refreshes = 0;
    const dispose = startGlobalSessionsPolling(
      () => new Promise<boolean>((resolve) => { finishInitial = resolve; }),
      async () => { refreshes += 1; return true; },
      clock.schedule, clock.clear, undefined,
      (listener) => { ready = listener; return () => undefined; },
    );
    ready();
    finishInitial(false);
    await flush();
    await flush();
    expect(refreshes).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
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
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('a refresh that comes due while hidden waits for the app to be visible again', async () => {
    const clock = timers();
    let hidden = false;
    let notifyVisible: () => void = () => undefined;
    let listening = false;
    const visibility = {
      isHidden: () => hidden,
      onVisible: (listener: () => void) => {
        notifyVisible = listener;
        listening = true;
        return () => { listening = false; };
      },
    };
    let refreshes = 0;
    const dispose = startGlobalSessionsPolling(
      async () => true,
      async () => { refreshes += 1; return true; },
      clock.schedule, clock.clear, visibility,
    );
    await flush();

    hidden = true;
    await clock.fire();
    expect(refreshes).toBe(0);
    expect(clock.pending.size).toBe(0);

    // Becoming visible runs the missed refresh once and resumes the cadence.
    hidden = false;
    notifyVisible();
    await flush();
    expect(refreshes).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    // Returning before another refresh comes due still takes a full snapshot.
    notifyVisible();
    await flush();
    expect(refreshes).toBe(2);
    expect(clock.pending.size).toBe(1);
    dispose();
    expect(listening).toBe(false);
  });

  test('a stream gap checks the head of the list and leaves the full snapshot on its schedule', async () => {
    const clock = timers();
    let now = 0;
    let gap: () => void = () => undefined;
    let fullLoads = 0;
    let headChecks = 0;
    let finishInitial: (success: boolean) => void = () => undefined;
    const dispose = startGlobalSessionsPolling(
      () => { fullLoads += 1; return new Promise<boolean>((resolve) => { finishInitial = resolve; }); },
      async () => { fullLoads += 1; return true; },
      clock.schedule, clock.clear, undefined, undefined,
      async () => { headChecks += 1; return true; },
      () => now,
      (listener) => { gap = listener; return () => { gap = () => undefined; }; },
    );
    // The first load may have read its pages before the gap: the head is
    // checked once it lands.
    gap();
    expect(headChecks).toBe(0);
    finishInitial(true);
    await flush();
    await flush();
    expect(headChecks).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);

    now += 60_000;
    gap();
    await flush();
    expect(headChecks).toBe(2);
    expect(fullLoads).toBe(1);
    expect(clock.pending.size).toBe(1);
    // The snapshot keeps its deadline, counted from the last snapshot.
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS - 60_000);

    now += GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS - 60_000;
    await clock.fire();
    expect(fullLoads).toBe(2);
    expect(headChecks).toBe(2);
    dispose();
    gap();
    await flush();
    expect(headChecks).toBe(2);
  });

  test('head checks of later gaps do not push a failed snapshot retry away', async () => {
    const clock = timers();
    let now = 0;
    let gap: () => void = () => undefined;
    let fullLoads = 0;
    let fullFails = false;
    const dispose = startGlobalSessionsPolling(
      async () => { fullLoads += 1; return true; },
      async () => { fullLoads += 1; return !fullFails; },
      clock.schedule, clock.clear, undefined, undefined,
      async () => true,
      () => now,
      (listener) => { gap = listener; return () => undefined; },
    );
    await flush();
    fullFails = true;
    now = GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS;
    await clock.fire();
    expect(fullLoads).toBe(2);
    const retryAt = now + GLOBAL_SESSIONS_RETRY_INTERVAL_MS;
    // Reconnects before the retry is due, each with a successful head check.
    for (const offset of [20_000, 20_000]) {
      now += offset;
      gap();
      await flush();
      expect(clock.delay()).toBe(retryAt - now);
    }
    fullFails = false;
    now = retryAt;
    await clock.fire();
    expect(fullLoads).toBe(3);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    dispose();
  });

  test('a head check a gap asked for retries after a failure and keeps the snapshot deadline', async () => {
    const clock = timers();
    let now = 0;
    let gap: () => void = () => undefined;
    let fullLoads = 0;
    let headChecks = 0;
    let headFails = true;
    const dispose = startGlobalSessionsPolling(
      async () => { fullLoads += 1; return true; },
      async () => { fullLoads += 1; return true; },
      clock.schedule, clock.clear, undefined, undefined,
      async () => { headChecks += 1; return !headFails; },
      () => now,
      (listener) => { gap = listener; return () => undefined; },
    );
    await flush();
    now += 100_000;
    gap();
    await flush();
    expect(headChecks).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_RETRY_INTERVAL_MS);
    headFails = false;
    now += GLOBAL_SESSIONS_RETRY_INTERVAL_MS;
    await clock.fire();
    expect(headChecks).toBe(2);
    expect(fullLoads).toBe(1);
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS - 100_000 - GLOBAL_SESSIONS_RETRY_INTERVAL_MS);
    dispose();
  });

  test('a stream gap during a load checks the head right after it', async () => {
    const clock = timers();
    let gap: () => void = () => undefined;
    let headChecks = 0;
    let finishRefresh: (success: boolean) => void = () => undefined;
    let visible: () => void = () => undefined;
    const dispose = startGlobalSessionsPolling(
      async () => true,
      () => new Promise<boolean>((resolve) => { finishRefresh = resolve; }),
      clock.schedule, clock.clear,
      { isHidden: () => false, onVisible: (listener) => { visible = listener; return () => undefined; } },
      undefined,
      async () => { headChecks += 1; return true; },
      Date.now,
      (listener) => { gap = listener; return () => undefined; },
    );
    await flush();
    visible();
    gap();
    expect(headChecks).toBe(0);
    finishRefresh(true);
    await flush();
    await flush();
    expect(headChecks).toBe(1);
    expect(clock.pending.size).toBe(1);
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
    expect(clock.delay()).toBe(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
    expect(list.mock.calls.every(([options]) => options?.global === true)).toBe(true);
    // A stream gap reads the head of the list, without the host seed.
    const seedsBeforeHeadCheck = host.mock.calls.length;
    await act(async () => notifyStreamGap('startup-a'));
    expect(list.mock.calls.at(-1)?.[0]?.limit).toBe(20);
    expect(host.mock.calls.length).toBe(seedsBeforeHeadCheck);
    // Another runtime's gap reads nothing here.
    const listsBeforeForeignGap = list.mock.calls.length;
    await act(async () => notifyStreamGap('another-runtime'));
    expect(list.mock.calls.length).toBe(listsBeforeForeignGap);

    const oldPage = new Promise<SessionPage>((resolve) => { resolveOldPage = resolve; });
    list.mockImplementationOnce(() => oldPage);
    // The ten-minute snapshot, still waiting for its first page.
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

/**
 * Each window renders its own app root with its own global sessions store,
 * so every root whose UI lists sessions from that store must start the
 * polling itself. The Mini Chat window's session switcher once read an
 * empty store because its root never did (#4643).
 */
describe('global session polling root coverage', () => {
  // VS Code's Settings editor tab is a VSCodeApp root that lists no
  // sessions, so there the poller is gated on the panel kind; the chat panel
  // still polls.
  const rootSources: Array<[string, string, RegExp]> = [
    ['App', '../App.tsx', /^\s*useGlobalSessionsPolling\(true\);/m],
    ['VSCodeApp', '../apps/VSCodeApp.tsx', /^\s*useGlobalSessionsPolling\(!isSettingsPanel\);/m],
    ['ElectronMiniChatApp', '../apps/ElectronMiniChatApp.tsx', /^\s*useGlobalSessionsPolling\(true\);/m],
  ];

  for (const [rootName, sourcePath, mountCall] of rootSources) {
    test(`${rootName} mounts useGlobalSessionsPolling`, () => {
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      expect(mountCall.test(source)).toBe(true);
    });
  }

  // The mobile shell has no poller on purpose: its sessions sheet loads the
  // list when it opens. That load must run the host seed too, or a question
  // already waiting at startup never reaches the index its rows read (#5098).
  test('the mobile sessions sheet seeds the host index after its own load', () => {
    const source = readFileSync(new URL('../apps/MobileSessionsSheet.tsx', import.meta.url), 'utf8');
    expect(/refreshGlobalSessions\(liveSessions\)\.then\(\(\) => seedGlobalSessionStatusFromHost\(\)\)/.test(source)).toBe(true);
  });
});
