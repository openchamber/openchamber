import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useTerminalStore } from '@/stores/useTerminalStore';

const touchCalls: string[][] = [];

const terminal = {
  touchSessions: async (sessionIds: string[]) => {
    touchCalls.push(sessionIds);
  },
};

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ terminal }),
}));

const { useTerminalSessionKeepalive } = await import('./useTerminalSessionKeepalive');

const HookHarness = () => {
  useTerminalSessionKeepalive();
  return null;
};

describe('useTerminalSessionKeepalive', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const scheduledIntervals = new Map<number, { delay: number; callback: () => void }>();
  let nextIntervalId = 1;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    scheduledIntervals.clear();
    nextIntervalId = 1;
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

/**
 * Every app root that renders terminals must own keepalive itself: the server
 * reaps sessions with no attached socket after 30 idle minutes, and the loop
 * no longer lives in TerminalView. The mobile shell runs its own root and
 * mounts neither desktop layout, so a missing call there silently reintroduces
 * background PTY reaping (reviewer finding on the revisit fix).
 */
describe('terminal keepalive root coverage', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rootSources: Array<[string, string]> = [
    ['MainLayout', join(__dirname, '..', 'components', 'layout', 'MainLayout.tsx')],
    ['VSCodeLayout', join(__dirname, '..', 'components', 'layout', 'VSCodeLayout.tsx')],
    ['MobileApp shell', join(__dirname, '..', 'apps', 'MobileApp.tsx')],
  ];

  for (const [rootName, sourcePath] of rootSources) {
    test(`${rootName} mounts useTerminalSessionKeepalive`, () => {
      const source = readFileSync(sourcePath, 'utf-8');
      expect(source).toContain('useTerminalSessionKeepalive()');
    });
  }
});
