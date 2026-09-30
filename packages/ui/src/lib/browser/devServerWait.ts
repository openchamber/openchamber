/**
 * When a browser tab waits for a local dev server instead of showing an error.
 *
 * A page opened the moment its dev server launched usually fails first:
 * nothing is listening yet. Those loads are retried for a while, because the
 * user or the agent that opened the page just started the server and expects
 * it to come up.
 *
 * A tab restored from saved state is different. Nobody asked for that load: it
 * happens at app launch, or when a project's panel is shown again, and its
 * server is usually just not running. Retrying it would hammer a closed port
 * for the whole wait, often in a panel nobody is looking at. So a restored
 * load runs once and fails honestly; the wait comes back with the next load
 * the user, the agent or the page starts.
 */
import type { BrowserNavStatus } from './contract';
import { isStartingServerFailure } from './url';

/** How long to keep waiting for a dev server that is still coming up. */
export const DEV_SERVER_WAIT_MS = 40_000;

/** Tab ids repeat across projects (`browser:<url>`), so every key carries its directory. */
const tabKey = (directory: string, tabID: string): string => `${directory}\n${tabID}`;

/**
 * Tabs just opened with an address, whose first load was asked for now rather
 * than restored. Session-only and forgotten once the tab has mounted, so a
 * later remount of the same tab counts as restored.
 */
const tabsOpenedWithAddress = new Set<string>();

export const noteBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.add(tabKey(directory, tabID));
};

/** False for a tab restored from saved state. Pure, so it is safe to read while rendering. */
export const wasBrowserTabOpenedWithAddress = (directory: string, tabID: string): boolean => (
  tabsOpenedWithAddress.has(tabKey(directory, tabID))
);

/** Called once the tab has mounted: any later mount is a restore. */
export const forgetBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.delete(tabKey(directory, tabID));
};

type LoadRequestListener = (url: string) => void;

/** Mounted tabs listening for someone asking them to load an address again. */
const loadRequestListeners = new Map<string, Set<LoadRequestListener>>();

/**
 * Asks an existing tab to load an address, as if the user had typed it.
 *
 * Opening an address that already has a tab only focuses that tab, which is
 * not enough when the tab is showing a failure: a project action that just
 * started the server announces the same address, and the page must load now,
 * waiting for the server like any other load someone started. The tab decides
 * with {@link acceptsBrowserTabLoadRequest}; a tab that is not mounted misses
 * the request and loads on its next mount instead.
 */
export const requestBrowserTabLoad = (directory: string, tabID: string, url: string): void => {
  const listeners = loadRequestListeners.get(tabKey(directory, tabID));
  if (!listeners) return;
  for (const listener of listeners) listener(url);
};

/**
 * Whether a mounted tab acts on a load request. Only a tab showing a failure,
 * or one that has not shown a page yet, loads again: reloading a working page
 * would throw away whatever the person had on it, so that tab is only focused.
 */
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

export type DevServerWaitRun = { readonly url: string; readonly startedAt: number };

type FailedLoad = { readonly code: number; readonly url: string };

type FailedLoadPlan = {
  readonly retry: boolean;
  /** The run to keep for the next failure. */
  readonly run: DevServerWaitRun | null;
};

/**
 * Decides whether a failed load is retried.
 *
 * `restored` marks the load a tab made from saved state: it is never retried.
 * Otherwise a loopback address that is not answering yet is retried until the
 * run that began with its first failure has lasted {@link DEV_SERVER_WAIT_MS}.
 */
export const planFailedLoadRetry = (
  failure: FailedLoad,
  { run, restored, now }: { run: DevServerWaitRun | null; restored: boolean; now: number },
): FailedLoadPlan => {
  if (restored || !isStartingServerFailure(failure.code, failure.url)) {
    return { retry: false, run };
  }
  const current = run?.url === failure.url ? run : { url: failure.url, startedAt: now };
  return { retry: now - current.startedAt <= DEV_SERVER_WAIT_MS, run: current };
};
