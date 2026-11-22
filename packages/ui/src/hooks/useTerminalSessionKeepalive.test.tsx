import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs, TerminalAPI } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useTerminalSessionKeepalive } from './useTerminalSessionKeepalive';

const touchCalls: string[][] = [];

const unavailable = (): never => {
  throw new Error('Terminal keepalive must not call this runtime API');
};

const terminal: TerminalAPI = {
  touchSessions: async (sessionIds: string[]) => {
    touchCalls.push(sessionIds);
  },
  createSession: unavailable,
  connect: unavailable,
  sendInput: unavailable,
  resize: unavailable,
  close: unavailable,
};

// Real runtime APIs through the context the app itself uses: mock.module
// stays registered for every later test file in the process and breaks
// them (#46), so the fixture terminal arrives via RuntimeAPIContext.
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  terminal,
  get git() { return unavailable(); },
  get sourceControl() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
};

const KeepaliveProbe = () => {
  useTerminalSessionKeepalive();
  return null;
};

const HookHarness = () => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <KeepaliveProbe />
  </RuntimeAPIContext.Provider>
);

describe('useTerminalSessionKeepalive', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduledIntervals = new Map<number, { delay: number; callback: () => void }>();
  let nextIntervalId = 1;
  const globalNames = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  let originalGlobals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    scheduledIntervals.clear();
    nextIntervalId = 1;
    // Capture the globals this suite replaces so afterEach can put them
    // back: leaving a happy-dom window installed makes later test files
    // load against it (for example useConfigStore reads a bare
    // `localStorage` global once `window` exists) and fail at load (#46).
    originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const windowSetInterval = windowInstance.setInterval.bind(windowInstance);
    const windowClearInterval = windowInstance.clearInterval.bind(windowInstance);
    const fakeSetInterval = (callback: TimerHandler, delay = 0, ...args: unknown[]) => {
      const liveHandle = windowSetInterval(() => undefined, 0);
      windowClearInterval(liveHandle);
      const id = nextIntervalId;
      nextIntervalId += 1;
      const callbackFn = () => {
        if (callback instanceof Function) {
          callback(...args);
          return;
        }
        new Function(String(callback))();
      };
      scheduledIntervals.set(id, {
        delay,
        callback: callbackFn,
      });
      return id;
    };
    const fakeClearInterval = (intervalId: number) => {
      scheduledIntervals.delete(intervalId);
    };
    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: fakeSetInterval,
    });
    Object.defineProperty(globalThis, 'clearInterval', {
      configurable: true,
      writable: true,
      value: fakeClearInterval,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    touchCalls.length = 0;
    useTerminalStore.getState().clearAll();

    const interactiveTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabSessionId('/repo', interactiveTabId, 'interactive-session');
    useTerminalStore.getState().setTabLifecycle('/repo', interactiveTabId, 'running');

    const runningActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', runningActionTabId, {
      type: 'project-action',
      actionId: 'build',
      executionId: 'exec-1',
    });
    useTerminalStore.getState().setTabSessionId('/repo', runningActionTabId, 'action-session');
    useTerminalStore.getState().setTabLifecycle('/repo', runningActionTabId, 'running');

    const exitedTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabSessionId('/repo', exitedTabId, 'exited-session');
    useTerminalStore.getState().setTabLifecycle('/repo', exitedTabId, 'exited');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      writable: true,
      value: originalSetInterval,
    });
    Object.defineProperty(globalThis, 'clearInterval', {
      configurable: true,
      writable: true,
      value: originalClearInterval,
    });
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    useTerminalStore.getState().clearAll();
  });

  test('touches non-exited tab sessions immediately and on the interval, without a TerminalView mount', async () => {
    await act(async () => {
      root.render(React.createElement(HookHarness));
    });

    expect(touchCalls).toEqual([['interactive-session', 'action-session']]);
    expect([...scheduledIntervals.values()].map((entry) => entry.delay)).toEqual([10 * 60 * 1000]);

    await act(async () => {
      [...scheduledIntervals.values()][0]?.callback();
    });

    expect(touchCalls).toEqual([
      ['interactive-session', 'action-session'],
      ['interactive-session', 'action-session'],
    ]);
  });

  test('skips touches while offline and clears the interval on unmount', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });

    await act(async () => {
      root.render(React.createElement(HookHarness));
    });

    expect(touchCalls).toEqual([]);
    expect(scheduledIntervals.size).toBe(1);

    await act(async () => {
      root.unmount();
    });

    expect(scheduledIntervals.size).toBe(0);
  });
});
