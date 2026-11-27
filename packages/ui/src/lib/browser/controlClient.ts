import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import type { BrowserControlRequestContext } from './controlEvents';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';
import { canDriveBrowserPage } from './hostCapability';
import {
  isPreferredElsewhere,
  noteBrowserPreferredConnection,
  noteBrowserStreamConnection,
  startReportingBrowserInput,
  stopReportingBrowserInput,
} from './preferredClient';

type BrowserControlRequest = {
  readonly requestId: string;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
  readonly context: BrowserControlRequestContext;
  readonly preferredConnectionId: string | null;
};

type BrowserTabOwnership = {
  readonly directory: string;
  readonly ownerSessionId: string | null;
};

type BrowserController = BrowserTabOwnership & {
  readonly tabId: string;
  readonly describe: () => { title: string; url: string };
  readonly run: (action: string, parameters: Record<string, unknown>, actingSessionId: string | null) => Promise<unknown>;
};

type SleepingBrowserTab = BrowserTabOwnership & {
  readonly tabId: string;
  readonly describe: () => { title: string; url: string };
  readonly wake: () => void;
};

type RegisteredTab = BrowserController | SleepingBrowserTab;

type BrowserOpener = (url: string, context: BrowserControlRequestContext, options?: { usesUserLogins?: boolean }) => string | null;

type BrowserCloser = (directory: string, tabId: string) => boolean;

type Caller = {
  readonly sessionId: string | null;
  readonly directory: string | null;
};

const callerOf = (context: BrowserControlRequestContext): Caller => ({
  sessionId: context.sessionId,
  directory: context.directory ? normalizeContextPanelDirectoryKey(context.directory) : null,
});

const VIEW_ATTACH_TIMEOUT_MS = 2_000;
const settledPageSchema = z.object({
  title: z.string(),
  settled: z.boolean(),
  dialogs: z.array(z.unknown()).optional(),
  note: z.string().optional(),
});
const OPEN_ANSWER_BUDGET_MS = 40_000;
const VIEW_ATTACH_POLL_MS = 50;

const UNKNOWN_TAB_CLAIM_DELAY_MS = 400;

const PREFERRED_CLIENT_HEAD_START_MS = 1_500;

const controllers = new Map<string, BrowserController>();
const sleepingTabs = new Map<string, SleepingBrowserTab>();
let shownDirectory: string | null = null;
let shownTabId: string | null = null;
const lastTabBySession = new Map<string, string>();
let opener: BrowserOpener | null = null;
let closer: BrowserCloser | null = null;
let activityListener: ((directory: string, tabId: string) => void) | null = null;
let unsubscribe: (() => void) | null = null;

const claimRequest = async (requestId: string): Promise<boolean> => {
  try {
    const response = await runtimeFetch('/api/browser-control/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    if (!response.ok) return false;
    const body = await response.json() as { granted?: boolean };
    return body?.granted === true;
  } catch {
    return false;
  }
};

const postResult = async (requestId: string, outcome: { ok: boolean; data?: unknown; error?: string }): Promise<void> => {
  try {
    const response = await runtimeFetch('/api/browser-control/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, ...outcome }),
    });
    if (!response.ok) {
      console.warn(
        `[browser-control] the server rejected the result for ${requestId} (HTTP ${response.status}); `
        + 'the agent will see this action time out',
      );
    }
  } catch (error) {
    console.warn(`[browser-control] could not deliver the result for ${requestId}:`, error);
  }
};

const waitForTab = async (
  tabId: string,
  timeoutMs = VIEW_ATTACH_TIMEOUT_MS,
): Promise<BrowserController | null> => {
  const deadline = Date.now() + timeoutMs;
  while (!controllers.has(tabId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VIEW_ATTACH_POLL_MS));
  }
  return controllers.get(tabId) ?? null;
};

const hasTab = (tabId: string): boolean => controllers.has(tabId) || sleepingTabs.has(tabId);

const tabOf = (tabId: string): RegisteredTab | null => controllers.get(tabId) ?? sleepingTabs.get(tabId) ?? null;

const registeredTabs = (): RegisteredTab[] => [
  ...controllers.values(),
  ...[...sleepingTabs.values()].filter((tab) => !controllers.has(tab.tabId)),
];

const defaultTabFor = (caller: Caller): string | null => {
  const shownCandidate = shownTabId ? tabOf(shownTabId) : null;
  const shown = shownCandidate?.directory === shownDirectory ? shownCandidate : null;
  if (!caller.sessionId) {
    if (shown) return shown.tabId;
    const onScreen = registeredTabs().filter((tab) => tab.directory === shownDirectory);
    const views = onScreen.filter((tab) => controllers.has(tab.tabId));
    const candidates = views.length > 0 ? views : onScreen;
    return candidates.length > 0 ? candidates[candidates.length - 1].tabId : null;
  }

  if (shown?.ownerSessionId === caller.sessionId) return shown.tabId;
  const last = lastTabBySession.get(caller.sessionId);
  if (last && tabOf(last)?.ownerSessionId === caller.sessionId) return last;
  const owned = registeredTabs().filter((tab) => tab.ownerSessionId === caller.sessionId);
  if (owned.length > 0) return owned[owned.length - 1].tabId;

  if (shown && shown.ownerSessionId === null && (!caller.directory || shown.directory === caller.directory)) {
    return shown.tabId;
  }
  return null;
};

const ownedTabFor = (caller: Caller): string | null => {
  const resolved = defaultTabFor(caller);
  if (!resolved) return null;
  return tabOf(resolved)?.ownerSessionId === caller.sessionId ? resolved : null;
};

const rememberTab = (caller: Caller, tabId: string): void => {
  if (caller.sessionId && tabOf(tabId)?.ownerSessionId === caller.sessionId) {
    lastTabBySession.set(caller.sessionId, tabId);
  }
};

const viewForTab = async (tabId: string): Promise<BrowserController | null> => {
  const mounted = controllers.get(tabId);
  if (mounted) return mounted;
  const sleeping = sleepingTabs.get(tabId);
  if (!sleeping) return null;
  sleeping.wake();
  return waitForTab(tabId);
};

type TabOwner = 'you' | 'user' | 'another session';

type ListedTab = { id: string; title: string; url: string; owner: TabOwner; active: boolean };

const listTabs = (caller: Caller): ListedTab[] => {
  const active = defaultTabFor(caller);
  return registeredTabs()
    .filter((tab) => !caller.sessionId
      || !caller.directory
      || tab.ownerSessionId === caller.sessionId
      || tab.directory === caller.directory)
    .map((tab) => {
      let described = { title: '', url: '' };
      try {
        described = tab.describe();
      } catch {
        // A view that cannot say what it shows is still a tab the agent may name.
      }
      const owner: TabOwner = tab.ownerSessionId === null
        ? 'user'
        : tab.ownerSessionId === caller.sessionId ? 'you' : 'another session';
      return { id: tab.tabId, title: described.title, url: described.url, owner, active: tab.tabId === active };
    });
};

const unloadableTabError = (tabId: string): string => (
  `The browser tab ${tabId} could not be loaded. Try again, or open the page in a new tab with browser.open.`
);

const unknownTabError = (tabId: string): string => (
  `There is no browser tab with id ${tabId}. Call browser.snapshot to list the open tabs, or omit tabId to use this session's own tab.`
);

const noTabForSessionError = (caller: Caller): string => {
  const tabs = listTabs(caller);
  const listing = tabs.length > 0
    ? ` Open tabs:\n${tabs.map((tab) => `- ${tab.id}: ${tab.title || tab.url || 'blank'} (opened by ${tab.owner})`).join('\n')}`
    : '';
  return 'This session has no browser tab of its own, and the user is not looking at a tab of theirs in this session\'s project. '
    + 'Nothing was changed. Open the page with browser.open, or pass tabId to work in a tab the user points you to.'
    + listing;
};

const noOwnedTabError = (): string => (
  'This session has no browser tab of its own to close. '
  + 'Agent actions never close a tab the user opened. '
  + 'Open a page with browser.open first, or name a tab this session opened with tabId.'
);

const notOwnedTabError = (tabId: string): string => (
  `The browser tab ${tabId} was not opened by this session, so it was not closed. `
  + 'Agent actions never close a tab the user or another session opened. '
  + 'Name a tab from browser.snapshot whose owner is you.'
);

const noSessionCloseError = (): string => (
  'This browser.close did not come from a session, so there is no tab it opened to close. Nothing was closed.'
);

const answer = (request: BrowserControlRequest, outcome: { ok: boolean; data?: unknown; error?: string }): Promise<void> => (
  postResult(request.requestId, request.action === 'browser.open' && outcome.ok
    ? { ...outcome, data: Object.assign({}, outcome.data, { drivable: canDriveBrowserPage() }) }
    : outcome)
);

const handleCloseRequest = async (
  request: BrowserControlRequest,
  caller: Caller,
  explicitTabId: string | null,
): Promise<void> => {
  if (!caller.sessionId) {
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: noSessionCloseError() });
    return;
  }

  const tabId = explicitTabId ?? ownedTabFor(caller);

  if (tabId === null) {
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: noOwnedTabError() });
    return;
  }

  if (!hasTab(tabId)) {
    if (controllers.size === 0 && sleepingTabs.size === 0 && !closer) return;
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
    if (!hasTab(tabId)) {
      if (!await claimRequest(request.requestId)) return;
      await answer(request, { ok: false, error: unknownTabError(tabId) });
      return;
    }
  }

  const tab = tabOf(tabId);
  if (!tab || tab.ownerSessionId !== caller.sessionId) {
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: notOwnedTabError(tabId) });
    return;
  }

  if (!await claimRequest(request.requestId)) return;
  const closed = closer ? closer(tab.directory, tabId) : false;
  if (!closed) {
    await answer(request, {
      ok: false,
      error: closer
        ? `The browser tab ${tabId} could not be closed.`
        : 'There is no browser here to close a tab in.',
    });
    return;
  }
  if (caller.sessionId && lastTabBySession.get(caller.sessionId) === tabId) {
    lastTabBySession.delete(caller.sessionId);
  }
  await answer(request, { ok: true, data: { closed: true, tabId } });
};

const handleRequest = async (request: BrowserControlRequest): Promise<void> => {
  const isOpen = request.action === 'browser.open';
  const isClose = request.action === 'browser.close';
  const caller = callerOf(request.context);
  const { tabId: rawTabId, ...parameters } = request.parameters;
  const tabId = rawTabId === undefined ? null : String(rawTabId);

  if (isClose) {
    await handleCloseRequest(request, caller, tabId);
    return;
  }

  if (tabId !== null) {
    if (!hasTab(tabId)) {
      if (controllers.size === 0 && sleepingTabs.size === 0 && !opener) return;
      await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
      if (hasTab(tabId)) {
        await runOnTab(request, caller, tabId, parameters);
        return;
      }
      if (!await claimRequest(request.requestId)) return;
      await answer(request, { ok: false, error: unknownTabError(tabId) });
      return;
    }
    await runOnTab(request, caller, tabId, parameters);
    return;
  }

  const targetTabId = defaultTabFor(caller);
  if (!targetTabId && !(isOpen && opener)) {
    if (!caller.sessionId) return;
    const noTabDelay = UNKNOWN_TAB_CLAIM_DELAY_MS
      + (request.preferredConnectionId !== null ? PREFERRED_CLIENT_HEAD_START_MS : 0);
    await new Promise((resolve) => setTimeout(resolve, noTabDelay));
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: noTabForSessionError(caller) });
    return;
  }
  const usesOpener = isOpen && opener !== null;
  const usesSessionTab = !usesOpener && caller.sessionId !== null
    && tabOf(targetTabId!)?.ownerSessionId === caller.sessionId;
  const fallsBack = !usesOpener && caller.sessionId !== null && !usesSessionTab;
  const yieldsToPreferred = !usesSessionTab && isPreferredElsewhere(request.preferredConnectionId);
  const claimDelay = (fallsBack ? UNKNOWN_TAB_CLAIM_DELAY_MS : 0)
    + (yieldsToPreferred ? PREFERRED_CLIENT_HEAD_START_MS : 0);
  if (claimDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, claimDelay));
  }

  if (!await claimRequest(request.requestId)) return;

  try {
    const url = typeof request.parameters.url === 'string' ? request.parameters.url : '';
    if (isOpen && !url) {
      await answer(request, { ok: false, error: 'url is required' });
      return;
    }
    const openStartedAt = Date.now();
    const openedTabId = isOpen && opener ? opener(url, request.context) : null;
    if (isOpen && !openedTabId && !targetTabId) {
      await answer(request, { ok: false, error: 'There is no browser here to open the page in.' });
      return;
    }
    if (openedTabId) {
      if (caller.sessionId) lastTabBySession.set(caller.sessionId, openedTabId);

      const requestedViewport = typeof request.parameters.viewport === 'string'
        ? request.parameters.viewport
        : '';
      const resize = Boolean(requestedViewport) && requestedViewport !== 'fill';
      const settle = canDriveBrowserPage();
      if (!resize && !settle) {
        await answer(request, { ok: true, data: { url, opened: true, tabId: openedTabId } });
        return;
      }

      const attached = await waitForTab(openedTabId);
      if (!attached && !resize) {
        await answer(request, { ok: true, data: { url, opened: true, tabId: openedTabId, settled: false } });
        return;
      }
      if (!attached) {
        await answer(request, {
          ok: true,
          data: {
            url,
            opened: true,
            tabId: openedTabId,
            viewportApplied: false,
            note: 'The panel had no browser view yet, so the viewport was not applied. Call browser.resize now that one exists.',
          },
        });
        return;
      }

      const resized = resize ? await attached.run('browser.resize', { viewport: requestedViewport }, caller.sessionId) : null;
      const viewport = resized && typeof resized === 'object'
        ? (resized as { viewport?: unknown }).viewport ?? null
        : null;
      const budgetMs = Math.max(0, OPEN_ANSWER_BUDGET_MS - (Date.now() - openStartedAt));
      const settleParameters = request.parameters.dialog === 'accept' ? { budgetMs, dialog: 'accept' } : { budgetMs };
      const page = settle
        ? settledPageSchema.safeParse(await attached.run('browser.settle', settleParameters, caller.sessionId).catch(() => null))
        : null;
      await answer(request, {
        ok: true,
        data: Object.assign(
          { url, opened: true, tabId: openedTabId },
          resize ? { viewportApplied: true, viewport } : {},
          page ? (page.success ? page.data : { settled: false }) : {},
        ),
      });
      return;
    }

    const view = await viewForTab(targetTabId!);
    await answer(request, view
      ? await runAction(view, caller, request.action, parameters)
      : { ok: false, error: unloadableTabError(targetTabId!) });
  } catch (error) {
    await answer(request, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const runOnTab = async (
  request: BrowserControlRequest,
  caller: Caller,
  tabId: string,
  parameters: BrowserControlRequest['parameters'],
): Promise<void> => {
  if (!await claimRequest(request.requestId)) return;
  rememberTab(caller, tabId);
  const view = await viewForTab(tabId);
  await answer(request, view
    ? await runAction(view, caller, request.action, parameters)
    : { ok: false, error: unloadableTabError(tabId) });
};

const runAction = async (
  controller: BrowserController,
  caller: Caller,
  action: string,
  parameters: BrowserControlRequest['parameters'],
): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
  activityListener?.(controller.directory, controller.tabId);
  try {
    const data = await controller.run(action, parameters, caller.sessionId);
    if (action === 'browser.snapshot' && Object(data) === data) {
      return { ok: true, data: { ...Object(data), tabs: listTabs(caller) } };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const ensureSubscribed = (): void => {
  if (unsubscribe) return;
  startReportingBrowserInput();
  unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type === 'event-stream-ready') {
      noteBrowserStreamConnection(event.connectionId);
      return;
    }
    if (event.type === 'browser-control-preferred') {
      noteBrowserPreferredConnection(event.connectionId);
      return;
    }
    if (event.type !== 'browser-control-request') return;
    void handleRequest({
      requestId: event.requestId,
      action: event.action,
      parameters: event.parameters,
      context: event.context,
      preferredConnectionId: event.preferredConnectionId,
    });
  });
};

const releaseIfIdle = (): void => {
  if (controllers.size > 0 || sleepingTabs.size > 0 || opener || closer || !unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
  stopReportingBrowserInput();
};

export const registerBrowserController = (controller: BrowserController): (() => void) => {
  controllers.set(controller.tabId, controller);
  ensureSubscribed();
  return () => {
    if (controllers.get(controller.tabId) === controller) controllers.delete(controller.tabId);
    releaseIfIdle();
  };
};

export const registerSleepingBrowserTab = (tab: SleepingBrowserTab): (() => void) => {
  sleepingTabs.set(tab.tabId, tab);
  ensureSubscribed();
  return () => {
    if (sleepingTabs.get(tab.tabId) === tab) sleepingTabs.delete(tab.tabId);
    releaseIfIdle();
  };
};

export const setShownBrowserTab = (directory: string, tabId: string | null): void => {
  shownDirectory = directory;
  if (tabId) shownTabId = tabId;
};

export const registerBrowserTabActivity = (listener: (directory: string, tabId: string) => void): (() => void) => {
  activityListener = listener;
  return () => {
    if (activityListener === listener) activityListener = null;
  };
};

export const openBrowserTabForSession = (url: string, context: BrowserControlRequestContext, options?: { usesUserLogins?: boolean }): string | null => (
  opener ? opener(url, context, options) : null
);

export const registerBrowserOpener = (open: BrowserOpener): (() => void) => {
  opener = open;
  ensureSubscribed();
  return () => {
    if (opener === open) opener = null;
    releaseIfIdle();
  };
};

export const registerBrowserCloser = (close: BrowserCloser): (() => void) => {
  closer = close;
  ensureSubscribed();
  return () => {
    if (closer === close) closer = null;
    releaseIfIdle();
  };
};
