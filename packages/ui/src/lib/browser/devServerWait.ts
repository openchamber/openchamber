import type { BrowserNavStatus } from './contract';
import { isStartingServerAnswer, isStartingServerFailure } from './url';

export const DEV_SERVER_WAIT_MS = 40_000;
export const DEV_SERVER_FIRST_RETRY_MS = 500;
export const DEV_SERVER_MAX_RETRY_MS = 4_000;
export const DEV_SERVER_AFTER_ACTION_MS = 3_000;
export const DEV_SERVER_ANSWER_WAIT_MS = 120_000;

const tabKey = (directory: string, tabID: string): string => `${directory}\n${tabID}`;

const tabsOpenedWithAddress = new Set<string>();
const firstLoadReferrers = new Map<string, BrowserTabReferrer>();

export type BrowserTabReferrer = { readonly url: string; readonly policy: string };

export const noteBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.add(tabKey(directory, tabID));
  firstLoadReferrers.delete(tabKey(directory, tabID));
};

export const noteBrowserTabFirstLoadReferrer = (directory: string, tabID: string, referrer: BrowserTabReferrer): void => {
  firstLoadReferrers.set(tabKey(directory, tabID), referrer);
};

export const browserTabFirstLoadReferrer = (directory: string, tabID: string): BrowserTabReferrer | undefined => (
  firstLoadReferrers.get(tabKey(directory, tabID))
);

export const wasBrowserTabOpenedWithAddress = (directory: string, tabID: string): boolean => (
  tabsOpenedWithAddress.has(tabKey(directory, tabID))
);

export const forgetBrowserTabOpenedWithAddress = (directory: string, tabID: string): void => {
  tabsOpenedWithAddress.delete(tabKey(directory, tabID));
  firstLoadReferrers.delete(tabKey(directory, tabID));
};

type LoadRequestListener = (url: string, referrer: BrowserTabReferrer | undefined) => void;

const loadRequestListeners = new Map<string, Set<LoadRequestListener>>();
let linkReferrer: BrowserTabReferrer | undefined;

export const openWithBrowserTabLinkReferrer = (referrer: BrowserTabReferrer | undefined, open: () => void): void => {
  const outer = linkReferrer;
  linkReferrer = referrer;
  try {
    open();
  } finally {
    linkReferrer = outer;
  }
};

export const requestBrowserTabLoad = (directory: string, tabID: string, url: string): void => {
  const listeners = loadRequestListeners.get(tabKey(directory, tabID));
  if (!listeners) return;
  for (const listener of listeners) listener(url, linkReferrer);
};

export const acceptsBrowserTabLoadRequest = (status: BrowserNavStatus, hasShownPage: boolean): boolean => (
  status.kind === 'failed'
  || (status.kind === 'ready' && status.httpStatus !== undefined && status.httpStatus >= 400)
  || !hasShownPage
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

type ErrorAnswer = { readonly url: string; readonly httpStatus?: number };

type RetryPlan =
  | { readonly next: 'stop' | 'pause'; readonly run: DevServerWaitRun | null }
  | { readonly next: 'retry'; readonly delayMs: number; readonly run: DevServerWaitRun };

type WaitContext = {
  run: DevServerWaitRun | null;
  restored: boolean;
  watched: boolean;
  now: number;
  actionRunning?: boolean;
  actionStoppedAt?: number | null;
};

const isJustAfterAction = ({ now, actionRunning = false, actionStoppedAt = null }: WaitContext): boolean => (
  !actionRunning && actionStoppedAt !== null && now - actionStoppedAt <= DEV_SERVER_AFTER_ACTION_MS
);

const planWait = (
  url: string,
  context: WaitContext,
  limitMs: number,
  limitWithActionMs: number,
): RetryPlan => {
  const { run, watched, now, actionRunning = false } = context;
  const current = run?.url === url ? run : { url, startedAt: now, paused: false };
  const waited = now - current.startedAt;
  const afterAction = isJustAfterAction(context);
  const limit = actionRunning || afterAction ? limitWithActionMs : limitMs;
  if (!current.paused && waited > limit) return { next: 'stop', run: current };
  if (!watched) return { next: 'pause', run: { ...current, paused: true } };
  if (current.paused) return { next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: { ...current, paused: false } };
  if (afterAction) return { next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: current };
  const delayMs = Math.min(DEV_SERVER_MAX_RETRY_MS, Math.max(DEV_SERVER_FIRST_RETRY_MS, waited / 2));
  return { next: 'retry', delayMs, run: current };
};

export const planFailedLoadRetry = (failure: FailedLoad, context: WaitContext): RetryPlan => {
  if (context.restored || !isStartingServerFailure(failure.code, failure.url)) {
    return { next: 'stop', run: context.run };
  }
  return planWait(failure.url, context, DEV_SERVER_WAIT_MS, Number.POSITIVE_INFINITY);
};

export const planErrorAnswerRetry = (answer: ErrorAnswer, context: WaitContext): RetryPlan => {
  const withAction = context.actionRunning === true || isJustAfterAction(context);
  if (
    context.restored
    || !withAction
    || answer.httpStatus === undefined
    || !isStartingServerAnswer(answer.httpStatus, answer.url)
  ) {
    return { next: 'stop', run: context.run };
  }
  return planWait(answer.url, context, DEV_SERVER_ANSWER_WAIT_MS, DEV_SERVER_ANSWER_WAIT_MS);
};
