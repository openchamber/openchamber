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
/**
 * The pause before the next retry. The first ones come quickly, so a server
 * that is only restarting is back on screen at once; the longer the wait has
 * run, the longer the pause, up to the cap. Every retry is a page load and a
 * line in the app's log, and a fixed 600 ms pause made that about 65 of each
 * per tab while a server was down.
 */
export const DEV_SERVER_FIRST_RETRY_MS = 500;
export const DEV_SERVER_MAX_RETRY_MS = 4_000;

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

export type DevServerWaitRun = {
  readonly url: string;
  readonly startedAt: number;
  /** Set while a retry was held back because nobody was watching the tab. */
  readonly paused: boolean;
};

type FailedLoad = { readonly code: number; readonly url: string };

type FailedLoadPlan =
  | { readonly next: 'stop' | 'pause'; readonly run: DevServerWaitRun | null }
  | { readonly next: 'retry'; readonly delayMs: number; readonly run: DevServerWaitRun };

/**
 * Decides what follows a failed load: a retry after a pause, holding the retry
 * back, or the error.
 *
 * `restored` marks the load a tab made from saved state: it is never retried.
 * Otherwise a loopback address that is not answering yet is retried until the
 * run that began with its first failure has lasted {@link DEV_SERVER_WAIT_MS}.
 * The pause grows with the time the run has lasted rather than with a count of
 * failures, so deciding again about the same failure gives the same answer.
 *
 * A tab nobody is watching does not retry: `watched` is false for a tab that
 * is not on screen, unless an agent is working it. The retry is held back
 * instead, and comes as soon as the tab is watched again, even if the wait ran
 * out meanwhile, since the server may well be up by then. A wait that ran out
 * in view has shown its error, and that error stays when the tab is hidden and
 * shown again.
 */
export const planFailedLoadRetry = (
  failure: FailedLoad,
  { run, restored, watched, now }: { run: DevServerWaitRun | null; restored: boolean; watched: boolean; now: number },
): FailedLoadPlan => {
  if (restored || !isStartingServerFailure(failure.code, failure.url)) {
    return { next: 'stop', run };
  }
  const current = run?.url === failure.url ? run : { url: failure.url, startedAt: now, paused: false };
  const waited = now - current.startedAt;
  if (!current.paused && waited > DEV_SERVER_WAIT_MS) return { next: 'stop', run: current };
  if (!watched) return { next: 'pause', run: { ...current, paused: true } };
  if (current.paused) return { next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: { ...current, paused: false } };
  const delayMs = Math.min(DEV_SERVER_MAX_RETRY_MS, Math.max(DEV_SERVER_FIRST_RETRY_MS, waited / 2));
  return { next: 'retry', delayMs, run: current };
};
