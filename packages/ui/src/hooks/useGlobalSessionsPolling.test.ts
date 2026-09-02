import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs, subscribeToInitialScopedDirectoryLoad } from '@/sync/sync-refs';
import {
  GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS,
  GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS,
  type GlobalSessionsPollingRuntime,
  startGlobalSessionsPolling,
  subscribeToBrowserRecoverySignals,
} from './useGlobalSessionsPolling';

const browserWindow = new Window();
Object.assign(globalThis, { window: browserWindow, document: browserWindow.document });

const setVisibilityState = (state: 'visible' | 'hidden') => {
  Object.defineProperty(browserWindow.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
};

const OLD_BLIND_REFRESH_INTERVAL_MS = 45_000;

type PendingInterval = {
  delay: number;
  callback: () => void;
  nextRunAt: number;
};

type PollingHarness = {
  runtime: GlobalSessionsPollingRuntime;
  advanceClock: (durationMs: number) => void;
  emitRecoverySignal: () => void;
  initialLoads: () => number;
  refreshes: () => number;
  scheduledDelays: () => number[];
  liveIntervals: () => number;
  liveSignalListeners: () => number;
};

type WaitForInitialScopedLoad = NonNullable<GlobalSessionsPollingRuntime['waitForInitialScopedLoad']>;

type ScopedLoadGate = {
  waitForInitialScopedLoad: WaitForInitialScopedLoad;
  settle: () => void;
  liveWaiters: () => number;
};

const createScopedLoadGate = (): ScopedLoadGate => {
  const waiters = new Set<() => void>();
  return {
    waitForInitialScopedLoad: (onSettled) => {
      waiters.add(onSettled);
      return () => {
        waiters.delete(onSettled);
      };
    },
    settle: () => {
      for (const waiter of [...waiters]) waiter();
    },
    liveWaiters: () => waiters.size,
  };
};

const createPollingHarness = (waitForInitialScopedLoad?: WaitForInitialScopedLoad): PollingHarness => {
  let currentTime = 0;
  let nextIntervalId = 1;
  let initialLoads = 0;
  let refreshes = 0;
  const intervals = new Map<number, PendingInterval>();
  const scheduledDelays: number[] = [];
  const signalListeners = new Set<() => void>();

  const runtime: GlobalSessionsPollingRuntime = {
    initialLoad: () => {
      initialLoads += 1;
    },
    waitForInitialScopedLoad,
    refresh: () => {
      refreshes += 1;
    },
    now: () => currentTime,
    scheduleInterval: (callback, delay) => {
      const intervalId = nextIntervalId;
      nextIntervalId += 1;
      scheduledDelays.push(delay);
      intervals.set(intervalId, { delay, callback, nextRunAt: currentTime + delay });
      return intervalId;
    },
    clearScheduledInterval: (intervalId) => {
      intervals.delete(intervalId);
    },
    subscribeToRecoverySignals: (onSignal) => {
      signalListeners.add(onSignal);
      return () => {
        signalListeners.delete(onSignal);
      };
    },
  };

  const nextDueInterval = (until: number): PendingInterval | null => {
    let due: PendingInterval | null = null;
    for (const interval of intervals.values()) {
      if (interval.nextRunAt > until) continue;
      if (!due || interval.nextRunAt < due.nextRunAt) due = interval;
    }
    return due;
  };

  const advanceClock = (durationMs: number) => {
    const target = currentTime + durationMs;
    for (let due = nextDueInterval(target); due; due = nextDueInterval(target)) {
      currentTime = due.nextRunAt;
      due.nextRunAt += due.delay;
      due.callback();
    }
    currentTime = target;
  };

  const emitRecoverySignal = () => {
    for (const listener of [...signalListeners]) listener();
  };

  return {
    runtime,
    advanceClock,
    emitRecoverySignal,
    initialLoads: () => initialLoads,
    refreshes: () => refreshes,
    scheduledDelays: () => [...scheduledDelays],
    liveIntervals: () => intervals.size,
    liveSignalListeners: () => signalListeners.size,
  };
};

describe('global sessions polling lifecycle', () => {
  test('loads the global list once and schedules only the coarse backstop', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);

    expect(harness.initialLoads()).toBe(1);
    expect(harness.refreshes()).toBe(0);
    expect(harness.scheduledDelays()).toEqual([GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS]);
    expect(harness.liveSignalListeners()).toBe(1);
  });

  test('does not refresh on the old blind cadence when no recovery signal arrives', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(OLD_BLIND_REFRESH_INTERVAL_MS * 5);

    expect(harness.refreshes()).toBe(0);
  });

  test('refreshes when a recovery signal arrives after the cooldown', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    harness.emitRecoverySignal();

    expect(harness.refreshes()).toBe(1);
  });

  test('collapses duplicate recovery signals inside the cooldown into one refresh', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    harness.emitRecoverySignal();
    harness.advanceClock(1_000);
    harness.emitRecoverySignal();
    harness.advanceClock(1_000);
    harness.emitRecoverySignal();

    expect(harness.refreshes()).toBe(1);
  });

  test('refreshes again for a recovery signal after the cooldown elapses', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    harness.emitRecoverySignal();
    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    harness.emitRecoverySignal();

    expect(harness.refreshes()).toBe(2);
  });

  test('backfills through the backstop interval when no recovery signal arrives', () => {
    const harness = createPollingHarness();

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS);

    expect(harness.refreshes()).toBe(1);
  });

  test('holds the first unscoped load until scoped startup settles', () => {
    const gate = createScopedLoadGate();
    const harness = createPollingHarness(gate.waitForInitialScopedLoad);

    startGlobalSessionsPolling(harness.runtime);
    expect(harness.initialLoads()).toBe(0);

    gate.settle();

    expect(harness.initialLoads()).toBe(1);
  });

  test('loads once however often the scoped gate settles', () => {
    const gate = createScopedLoadGate();
    const harness = createPollingHarness(gate.waitForInitialScopedLoad);

    startGlobalSessionsPolling(harness.runtime);
    gate.settle();
    gate.settle();

    expect(harness.initialLoads()).toBe(1);
  });

  test('anchors the refresh cooldown to the deferred load, not to start', () => {
    const gate = createScopedLoadGate();
    const harness = createPollingHarness(gate.waitForInitialScopedLoad);

    startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    gate.settle();
    harness.emitRecoverySignal();

    expect(harness.initialLoads()).toBe(1);
    expect(harness.refreshes()).toBe(0);

    harness.advanceClock(GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS);
    harness.emitRecoverySignal();

    expect(harness.refreshes()).toBe(1);
  });

  test('drops a pending scoped wait on disposal and never loads afterwards', () => {
    const gate = createScopedLoadGate();
    const harness = createPollingHarness(gate.waitForInitialScopedLoad);

    const dispose = startGlobalSessionsPolling(harness.runtime);
    dispose();

    expect(gate.liveWaiters()).toBe(0);

    gate.settle();

    expect(harness.initialLoads()).toBe(0);
  });

  test('still schedules recovery and the backstop while the first load waits', () => {
    const gate = createScopedLoadGate();
    const harness = createPollingHarness(gate.waitForInitialScopedLoad);

    startGlobalSessionsPolling(harness.runtime);

    expect(harness.scheduledDelays()).toEqual([GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS]);
    expect(harness.liveSignalListeners()).toBe(1);
    expect(harness.initialLoads()).toBe(0);
  });

  test('stops listening and clears the backstop on disposal', () => {
    const harness = createPollingHarness();

    const dispose = startGlobalSessionsPolling(harness.runtime);
    harness.advanceClock(GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS);
    dispose();

    expect(harness.liveIntervals()).toBe(0);
    expect(harness.liveSignalListeners()).toBe(0);

    harness.advanceClock(GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS * 3);
    harness.emitRecoverySignal();

    expect(harness.refreshes()).toBe(1);
  });
});

describe('browser recovery signals', () => {
  const dispatchOnWindow = (type: string) => {
    browserWindow.dispatchEvent(new browserWindow.Event(type));
  };

  const dispatchVisibilityChange = (state: 'visible' | 'hidden') => {
    setVisibilityState(state);
    browserWindow.document.dispatchEvent(new browserWindow.Event('visibilitychange'));
  };

  test('signals when the document becomes visible, on focus, pageshow, and system resume', () => {
    let signals = 0;
    setVisibilityState('visible');

    const unsubscribe = subscribeToBrowserRecoverySignals(() => {
      signals += 1;
    });

    dispatchVisibilityChange('visible');
    dispatchOnWindow('focus');
    dispatchOnWindow('pageshow');
    dispatchOnWindow('openchamber:system-resume');

    expect(signals).toBe(4);

    unsubscribe();
  });

  test('does not signal when the document becomes hidden', () => {
    let signals = 0;

    const unsubscribe = subscribeToBrowserRecoverySignals(() => {
      signals += 1;
    });

    dispatchVisibilityChange('hidden');

    expect(signals).toBe(0);

    unsubscribe();
  });

  test('removes every listener on unsubscribe', () => {
    let signals = 0;

    const unsubscribe = subscribeToBrowserRecoverySignals(() => {
      signals += 1;
    });
    unsubscribe();

    dispatchVisibilityChange('visible');
    dispatchOnWindow('focus');
    dispatchOnWindow('pageshow');
    dispatchOnWindow('openchamber:system-resume');

    expect(signals).toBe(0);
  });
});

describe('polling composed with the real scoped-startup gate', () => {
  const DIRECTORY = '/workspace';
  const managers: ChildStoreManager[] = [];

  const scopeDirectory = (directory: string): ChildStoreManager => {
    const manager = new ChildStoreManager();
    managers.push(manager);
    // SAFETY: setSyncRefs stores the SDK for other readers and never calls it here.
    setSyncRefs({} as never, manager, directory);
    return manager;
  };

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.disposeAll();
    // SAFETY: same unused SDK slot; clears the scoped directory between tests.
    setSyncRefs({} as never, new ChildStoreManager(), '');
  });

  test('arms global authority only after the scoped bootstrap finishes', async () => {
    const manager = scopeDirectory(DIRECTORY);
    let finishBootstrap!: () => void;
    const bootstrapping = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    manager.configure({ onBootstrap: () => bootstrapping });
    manager.requestBootstrap({ directory: DIRECTORY, priority: 'selected', reason: 'current-directory' });

    const harness = createPollingHarness(subscribeToInitialScopedDirectoryLoad);
    startGlobalSessionsPolling(harness.runtime);
    expect(harness.initialLoads()).toBe(0);

    finishBootstrap();
    await flushMicrotasks();

    expect(harness.initialLoads()).toBe(1);
  });

  test('loads on start when no directory is scoped', () => {
    scopeDirectory('');

    const harness = createPollingHarness(subscribeToInitialScopedDirectoryLoad);
    startGlobalSessionsPolling(harness.runtime);

    expect(harness.initialLoads()).toBe(1);
  });
});
