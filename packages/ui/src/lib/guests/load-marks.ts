import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { parseGuestMarksJson, type GuestMarkEntry } from './marks.ts';
import { useGuestMarksStore } from './marks-store.ts';

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];

const FOLLOW_UP_DELAY_MS = 100;

type Cancel = () => void;

type GuestMarksLoaderDeps = {
  read: () => Promise<GuestMarkEntry[] | null>;
  runtimeKey: () => string;
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
  let inFlight: { runtimeKey: string; again: boolean; request: Promise<void> } | null = null;
  let failures = 0;
  let cancelRetry: Cancel | null = null;

  const stopRetry = (): void => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const loadOnce = async (key: string, retry: boolean): Promise<void> => {
    stopRetry();
    if (!retry) failures = 0;
    if (useGuestMarksStore.getState().runtimeKey !== key) {
      useGuestMarksStore.getState().resetForRuntimeSwitch(key);
      failures = 0;
    }
    if (!supported()) return;
    const entries = await read();
    if (useGuestMarksStore.getState().runtimeKey !== key || runtimeKey() !== key) return;
    if (entries) {
      failures = 0;
      useGuestMarksStore.getState().replaceEntries(entries, key);
      return;
    }
    const delay = RETRY_DELAYS_MS[failures];
    if (delay === undefined) return;
    failures += 1;
    cancelRetry = later(() => {
      cancelRetry = null;
      if (runtimeKey() === key) void load(false, true);
    }, delay);
  };

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
    reload: (): Promise<void> => load(true, false),
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
