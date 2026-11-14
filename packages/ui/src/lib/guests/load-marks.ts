import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { parseGuestMarksJson, type GuestMarkEntry } from './marks.ts';
import { useGuestMarksStore } from './marks-store.ts';

/**
 * How long after a failed read the next one starts. The signal that a mark is
 * gone comes once, so a read that failed is tried again by itself, and then
 * left to the next signal.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];

/**
 * How long a read waits when changes were announced during the one before
 * it. A service that sets fifty marks announces fifty changes within a few
 * milliseconds; the first shows at once and the rest arrive in one more read.
 */
const FOLLOW_UP_DELAY_MS = 100;

type Cancel = () => void;

type GuestMarksLoaderDeps = {
  /** The marks the server lists, or null when the read failed. */
  read: () => Promise<GuestMarkEntry[] | null>;
  runtimeKey: () => string;
  /** VS Code loads no extensions. */
  supported: () => boolean;
  later: (run: () => void, delayMs: number) => Cancel;
};

const readGuestMarks = async (): Promise<GuestMarkEntry[] | null> => {
  try {
    const response = await runtimeFetch('/api/guests/marks');
    if (!response.ok) return null;
    return parseGuestMarksJson(await response.text());
  } catch {
    return null;
  }
};

export const createGuestMarksLoader = ({ read, runtimeKey, supported, later }: GuestMarksLoaderDeps) => {
  /** The reads running for one server; `again` asks for one more after the current one. */
  let inFlight: { runtimeKey: string; again: boolean; request: Promise<void> } | null = null;
  let failures = 0;
  let cancelRetry: Cancel | null = null;

  const stopRetry = (): void => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const loadOnce = async (key: string, retry: boolean): Promise<void> => {
    stopRetry();
    // Only a read the timer started continues the count: several changes
    // announced while the server is away must not use up the delays at once.
    if (!retry) failures = 0;
    if (useGuestMarksStore.getState().runtimeKey !== key) {
      useGuestMarksStore.getState().resetForRuntimeSwitch(key);
      failures = 0;
    }
    if (!supported()) return;
    const entries = await read();
    // The answer of a server the app no longer follows.
    if (useGuestMarksStore.getState().runtimeKey !== key || runtimeKey() !== key) return;
    if (entries) {
      failures = 0;
      useGuestMarksStore.getState().replaceEntries(entries, key);
      return;
    }
    // A failed read is not "no marks": what was shown stays until a read answers.
    const delay = RETRY_DELAYS_MS[failures];
    if (delay === undefined) return;
    failures += 1;
    cancelRetry = later(() => {
      cancelRetry = null;
      if (runtimeKey() === key) void load(false, true);
    }, delay);
  };

  /**
   * One read at a time per server. A read that began before a change was
   * announced may hold the old list, so one more follows it, after a pause
   * that lets a burst of changes share it; reads never overlap, so the last
   * answer is the newest.
   */
  const load = (changed: boolean, retry: boolean): Promise<void> => {
    const key = runtimeKey();
    if (inFlight?.runtimeKey === key) {
      if (changed) inFlight.again = true;
      return inFlight.request;
    }
    const flight = { runtimeKey: key, again: false, request: Promise.resolve() };
    const run = async (): Promise<void> => {
      await loadOnce(key, retry);
      while (flight.again) {
        await new Promise<void>((resolve) => { later(resolve, FOLLOW_UP_DELAY_MS); });
        if (runtimeKey() !== key) return;
        flight.again = false;
        await loadOnce(key, false);
      }
    };
    flight.request = run().finally(() => {
      if (inFlight === flight) inFlight = null;
    });
    inFlight = flight;
    return flight.request;
  };

  return {
    /** Something changed: the marks are read by a request that starts after now. */
    reload: (): Promise<void> => load(true, false),
    /** No extension shows marks any more: nothing is left to read again. */
    stop: (): void => {
      stopRetry();
      failures = 0;
    },
  };
};

const loader = createGuestMarksLoader({
  read: readGuestMarks,
  runtimeKey: getRuntimeKey,
  supported: () => !isVSCodeRuntime(),
  later: (run, delayMs) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
});

export const reloadGuestMarks = loader.reload;
export const stopGuestMarksRetry = loader.stop;
