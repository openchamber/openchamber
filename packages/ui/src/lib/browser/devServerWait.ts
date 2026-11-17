import type { BrowserNavStatus } from './contract';
import { isStartingServerFailure } from './url';

export const DEV_SERVER_WAIT_MS = 40_000;
export const DEV_SERVER_FIRST_RETRY_MS = 500;
export const DEV_SERVER_MAX_RETRY_MS = 4_000;
export const DEV_SERVER_AFTER_ACTION_MS = 3_000;

const tabKey = (directory: string, tabID: string): string => `${directory}\n${tabID}`;

const tabsOpenedWithAddress = new Set<string>();

export const noteBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.add(tabKey(directory, tabID));
};

export const wasBrowserTabOpenedWithAddress = (directory: string, tabID: string): boolean => (
  tabsOpenedWithAddress.has(tabKey(directory, tabID))
);

export const forgetBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.delete(tabKey(directory, tabID));
};

type LoadRequestListener = (url: string) => void;

const loadRequestListeners = new Map<string, Set<LoadRequestListener>>();

export const requestBrowserTabLoad = (directory: string, tabID: string, url: string): void => {
  const listeners = loadRequestListeners.get(tabKey(directory, tabID));
  if (!listeners) return;
  for (const listener of listeners) listener(url);
};

export const acceptsBrowserTabLoadRequest = (status: BrowserNavStatus, hasShownPage: boolean): boolean => (
  status.kind === 'failed' || !hasShownPage
);

export const subscribeBrowserTabLoadRequests = (
  directory: string,
  tabID: string,
  listener: LoadRequestListener,
): (() => void) => {
  const key = tabKey(directory, tabID);
  const listeners = loadRequestListeners.get(key) ?? new Set<LoadRequestListener>();
  listeners.add(listener);
  loadRequestListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) loadRequestListeners.delete(key);
  };
};

export type DevServerWaitRun = {
  readonly url: string;
  readonly startedAt: number;
  readonly paused: boolean;
};

type FailedLoad = { readonly code: number; readonly url: string };

type FailedLoadPlan =
  | { readonly next: 'stop' | 'pause'; readonly run: DevServerWaitRun | null }
  | { readonly next: 'retry'; readonly delayMs: number; readonly run: DevServerWaitRun };

export const planFailedLoadRetry = (
  failure: FailedLoad,
  { run, restored, watched, now, actionRunning = false, actionStoppedAt = null }: {
    run: DevServerWaitRun | null;
    restored: boolean;
    watched: boolean;
    now: number;
    actionRunning?: boolean;
    actionStoppedAt?: number | null;
  },
): FailedLoadPlan => {
  if (restored || !isStartingServerFailure(failure.code, failure.url)) {
    return { next: 'stop', run };
  }
  const current = run?.url === failure.url ? run : { url: failure.url, startedAt: now, paused: false };
  const waited = now - current.startedAt;
  const afterAction = !actionRunning && actionStoppedAt !== null && now - actionStoppedAt <= DEV_SERVER_AFTER_ACTION_MS;
  if (!current.paused && waited > DEV_SERVER_WAIT_MS && !actionRunning && !afterAction) return { next: 'stop', run: current };
  if (!watched) return { next: 'pause', run: { ...current, paused: true } };
  if (current.paused) return { next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: { ...current, paused: false } };
  if (afterAction) return { next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: current };
  const delayMs = Math.min(DEV_SERVER_MAX_RETRY_MS, Math.max(DEV_SERVER_FIRST_RETRY_MS, waited / 2));
  return { next: 'retry', delayMs, run: current };
};
