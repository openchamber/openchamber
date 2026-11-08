/**
 * Client half of agent browser control.
 *
 * The server broadcasts a browser request to every connected client, because it
 * cannot know which one is showing the browser panel. More than one may be able
 * to serve it, so a client asks the server for the request before doing
 * anything, and acts only if it is granted. Deciding by whose result arrives
 * first would be too late — by then every client has already clicked.
 *
 * `browser.open` is the exception: it is handled even with no view attached,
 * since opening a tab is precisely what creates one. The view it creates then
 * takes over the rest of that same request, so asking for a layout while
 * opening does not cost the agent a second call.
 *
 * Every browser tab registers its view under the tab's id, with the project it
 * belongs to and the session whose agent opened it (none for the user's own
 * tabs). An action with a `tabId` goes to that tab. Without one it goes to the
 * calling session's tab: the one the user is looking at if it is the
 * session's, else the one the session last opened or worked in. A session
 * with no tab of its own gets the tab the user is looking at, if that tab is
 * the user's and in the session's project; another session's tab is never
 * picked for it. Acting in a background tab does not switch the user to it.
 * Snapshots list the tabs with their ids and who opened them, so the agent can
 * name one.
 *
 * A request from an unknown session (an older server, or a caller with no
 * session) keeps the earlier rule: the tab the user last looked at.
 *
 * A tab restored from a previous run has no view until something needs it, so
 * it registers as asleep instead. It is listed like any other tab, and an
 * action that lands on it wakes it and waits for its view before running.
 *
 * `browser.close` is handled here rather than by a view: closing is panel
 * state, and no page can remove its own tab. The panel registers a closer, and
 * only a tab the calling session opened is passed to it; the user's tab and
 * another session's tab are refused, never closed.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeOpenchamberEvents, type BrowserControlRequestContext } from '@/lib/openchamberEvents';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';
import { canDriveBrowserPage } from './hostCapability';

type BrowserControlRequest = {
  readonly requestId: string;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
  readonly context: BrowserControlRequestContext;
};

/** Where a tab belongs; fixed for the tab's lifetime. */
type BrowserTabOwnership = {
  /** The project the tab is in, keyed as the context panel keys it. */
  readonly directory: string;
  /** The session whose agent opened the tab; null for a tab the user opened. */
  readonly ownerSessionId: string | null;
};

/** Implemented by the mounted browser pane. */
type BrowserController = BrowserTabOwnership & {
  /** The browser tab this view belongs to; the id agents pass as `tabId`. */
  readonly tabId: string;
  /** What the tab shows now, for the tab list in snapshots. */
  readonly describe: () => { title: string; url: string };
  /** Runs one action and resolves with its JSON-serializable result. */
  readonly run: (action: string, parameters: Record<string, unknown>) => Promise<unknown>;
};

/** A browser tab whose page has not been loaded, registered by the panel. */
type SleepingBrowserTab = BrowserTabOwnership & {
  readonly tabId: string;
  /** What the tab showed when it was last loaded, from its saved state. */
  readonly describe: () => { title: string; url: string };
  /** Loads the tab; its view then registers itself as a controller. */
  readonly wake: () => void;
};

type RegisteredTab = BrowserController | SleepingBrowserTab;

/**
 * Opens a URL in a new background tab for the calling session, in that
 * session's project, and returns the tab's id, or null when this client has
 * nowhere to open one.
 */
type BrowserOpener = (url: string, context: BrowserControlRequestContext) => string | null;

/**
 * Closes a browser tab in the panel. Registered by the panel, because closing
 * is panel state: no page view can remove its own tab. Returns whether a tab
 * was actually closed.
 */
type BrowserCloser = (directory: string, tabId: string) => boolean;

/** The session an action came from, with its project keyed like the panel's. */
type Caller = {
  readonly sessionId: string | null;
  readonly directory: string | null;
};

const callerOf = (context: BrowserControlRequestContext): Caller => ({
  sessionId: context.sessionId,
  directory: context.directory ? normalizeContextPanelDirectoryKey(context.directory) : null,
});

/**
 * How long a freshly opened tab is given to mount its view. A pane appears
 * within a frame or two; this is slack for a busy renderer, not a wait anyone
 * should ever notice.
 */
const VIEW_ATTACH_TIMEOUT_MS = 2_000;
/** What `browser.settle` tells about the page a new tab opened. */
const settledPageSchema = z.object({ title: z.string(), settled: z.boolean() });
/**
 * How long an open into a new tab may take before it answers: the server gives
 * up at 45 s (`openchamber-control/service.js`), and the answer still has to
 * get there. What the attach and the resize used is taken off the settle wait.
 */
const OPEN_ANSWER_BUDGET_MS = 40_000;
const VIEW_ATTACH_POLL_MS = 50;

/**
 * A client that does not have the tab an action names waits this long before
 * claiming it to answer "no such tab", so the client that has it wins the claim.
 */
const UNKNOWN_TAB_CLAIM_DELAY_MS = 400;

/** Mounted views by tab id, in registration order. */
const controllers = new Map<string, BrowserController>();
/** Tabs with no view yet, by tab id. A mounted view takes precedence. */
const sleepingTabs = new Map<string, SleepingBrowserTab>();
/** The project on screen, keyed as the context panel keys it. */
let shownDirectory: string | null = null;
/** The browser tab the user last had in front of them; counts only while its project is on screen. */
let shownTabId: string | null = null;
/**
 * The tab each session last opened or worked in, so its next action without a
 * `tabId` returns there. Module memory only: after a reload a session falls
 * back to its newest registered tab.
 */
const lastTabBySession = new Map<string, string>();
let opener: BrowserOpener | null = null;
let closer: BrowserCloser | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Delivers a result to the server.
 *
 * A dropped result is indistinguishable from an unreachable browser on the
 * agent's side, so a failure here is reported rather than swallowed — that
 * silence is what once turned a missing body parser into an unexplained
 * twenty-second timeout.
 */
/**
 * Asks for the exclusive right to perform a request.
 *
 * A refusal is the normal outcome for a client that lost the race, and so is a
 * failure to ask at all: acting without a grant is what this exists to prevent.
 */
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

/**
 * Waits for a browser view to register itself, or gives up.
 *
 * Polls rather than subscribes because registration is a plain assignment made
 * by whichever pane mounts; a callback would have to be maintained by every
 * caller of `registerBrowserController` for one waiter.
 */
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

/** Mounted views first, then sleeping tabs, each in registration order. */
const registeredTabs = (): RegisteredTab[] => [
  ...controllers.values(),
  ...[...sleepingTabs.values()].filter((tab) => !controllers.has(tab.tabId)),
];

/**
 * The tab an action that names none runs in, or null when the caller has
 * none it may use.
 */
const defaultTabFor = (caller: Caller): string | null => {
  const shownCandidate = shownTabId ? tabOf(shownTabId) : null;
  const shown = shownCandidate?.directory === shownDirectory ? shownCandidate : null;
  if (!caller.sessionId) {
    // Unknown caller: the tab the user is looking at, else the most recently
    // registered tab of the project on screen, views before sleeping tabs.
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

  // No tab of its own: the user's tab on screen, when it is in this session's
  // project. "Look at what I have open" works; another session's page and
  // another project's page are left alone.
  if (shown && shown.ownerSessionId === null && (!caller.directory || shown.directory === caller.directory)) {
    return shown.tabId;
  }
  return null;
};

/**
 * The tab an action without tabId may use, but only when this session opened
 * it. Closing must not fall back to the user's tab the way reading and driving
 * do: the user's page is not the agent's to remove. Called only for a caller
 * that has a session, which the close path checks first.
 */
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

/**
 * The view that runs an action in a tab, waking the tab first if it is asleep.
 * Waking loads a page, so this is called only once the request is claimed.
 */
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

/**
 * The tabs a caller may name: its own, and the other tabs of its project,
 * where the user may well ask about one. Tabs of other projects, the user's
 * or another session's, are left out. `active` marks the tab an action
 * without `tabId` would use.
 */
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

/** Lists what the caller could name instead, since it cannot take a snapshot to find out. */
const noTabForSessionError = (caller: Caller): string => {
  const tabs = listTabs(caller);
  const listing = tabs.length > 0
    ? ` Open tabs:\n${tabs.map((tab) => `- ${tab.id}: ${tab.title || tab.url || 'blank'} (opened by ${tab.owner})`).join('\n')}`
    : '';
  return 'This session has no browser tab of its own, and the user is not looking at a tab of theirs in this session\'s project. '
    + 'Nothing was changed. Open the page with browser.open, or pass tabId to work in a tab the user points you to.'
    + listing;
};

/** Says why nothing was closed when the session has no tab of its own here. */
const noOwnedTabError = (): string => (
  'This session has no browser tab of its own to close. '
  + 'Agent actions never close a tab the user opened. '
  + 'Open a page with browser.open first, or name a tab this session opened with tabId.'
);

/** Says why a named tab was not closed: it was not this session's to close. */
const notOwnedTabError = (tabId: string): string => (
  `The browser tab ${tabId} was not opened by this session, so it was not closed. `
  + 'Agent actions never close a tab the user or another session opened. '
  + 'Name a tab from browser.snapshot whose owner is you.'
);

/** Says why a caller with no session closed nothing. */
const noSessionCloseError = (): string => (
  'This browser.close did not come from a session, so there is no tab it opened to close. Nothing was closed.'
);

/**
 * Every successful open says whether this client can also drive the page, the
 * same per-client fact the event stream declared to the server; otherwise the
 * agent only learns a page is display-only when its next action fails.
 */
const answer = (request: BrowserControlRequest, outcome: { ok: boolean; data?: unknown; error?: string }): Promise<void> => (
  postResult(request.requestId, request.action === 'browser.open' && outcome.ok
    ? { ...outcome, data: Object.assign({}, outcome.data, { drivable: canDriveBrowserPage() }) }
    : outcome)
);

/**
 * Closes a tab this session opened. Closing is panel state, not a page action:
 * a view cannot remove its own tab, so the panel registers a closer. The
 * ownership gate is load-bearing here: a tab the user or another session
 * opened is never closed, even when an action without tabId would otherwise
 * have used it. A caller with no session owns no tab and is refused outright,
 * so a null session can never match an unowned (the user's) tab.
 */
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
    // No tab of this session's here. Another client may hold it, so that one
    // claims first; otherwise the agent hears why at once instead of waiting
    // out the timeout.
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: noOwnedTabError() });
    return;
  }

  if (!hasTab(tabId)) {
    // Another client may have this tab: let it claim first, and answer
    // "no such tab" only if nobody did. A client with the panel mounted still
    // answers when the tab is gone, rather than waiting out the timeout.
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
    // This client holds the tab and it is not the caller's to close.
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
      // Another client may have this tab: let it claim first, and answer
      // "no such tab" only if nobody did, instead of leaving the agent to time out.
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
    // A known session with no tab it may use here. Another client may hold its
    // tab, so that one claims first; otherwise the agent hears why at once
    // instead of waiting out the timeout.
    if (!caller.sessionId) return;
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
    if (!await claimRequest(request.requestId)) return;
    await answer(request, { ok: false, error: noTabForSessionError(caller) });
    return;
  }
  // Falling back to the user's tab: a client holding the session's own tab
  // must get the request, so it claims first.
  const usesOpener = isOpen && opener !== null;
  if (!usesOpener && caller.sessionId && tabOf(targetTabId!)?.ownerSessionId !== caller.sessionId) {
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
  }

  // Nothing below this line may touch a page without the server's grant.
  if (!await claimRequest(request.requestId)) return;

  try {
    // Opening a page without naming a tab makes a new background tab, so the
    // agent never replaces the page the user is on; the id comes back with
    // the answer and the agent keeps working in that tab.
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
      // The tab's view registers a moment later, so it is remembered here
      // rather than through its registration.
      if (caller.sessionId) lastTabBySession.set(caller.sessionId, openedTabId);

      const requestedViewport = typeof request.parameters.viewport === 'string'
        ? request.parameters.viewport
        : '';
      const resize = Boolean(requestedViewport) && requestedViewport !== 'fill';
      // Only a host that drives its pages can say how the page came out.
      const settle = canDriveBrowserPage();
      if (!resize && !settle) {
        await answer(request, { ok: true, data: { url, opened: true, tabId: openedTabId } });
        return;
      }

      // The tab was just created, so its view is a few frames away. Waiting for
      // it lets the layout the agent asked for be applied to the page it is
      // opening, rather than to the next call it has to make, and lets the
      // answer say whether that page has rendered.
      const attached = await waitForTab(openedTabId);
      if (!attached && !resize) {
        await answer(request, { ok: true, data: { url, opened: true, tabId: openedTabId, settled: false } });
        return;
      }
      if (!attached) {
        // Still no view. Reporting a plain success here would leave the agent
        // believing a size it asked for was applied to a page nobody is showing.
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

      const resized = resize ? await attached.run('browser.resize', { viewport: requestedViewport }) : null;
      const viewport = resized && typeof resized === 'object'
        ? (resized as { viewport?: unknown }).viewport ?? null
        : null;
      // The view loads the page itself; `browser.settle` waits it out the way
      // an open in a named tab does and reports `title` and `settled`.
      // The tab is open whatever the wait says, so a failed wait is `settled: false`, not an error.
      const page = settle
        ? settledPageSchema.safeParse(await attached.run('browser.settle', {
          budgetMs: Math.max(0, OPEN_ANSWER_BUDGET_MS - (Date.now() - openStartedAt)),
        }).catch(() => null))
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

/** An action that named its tab: claimed and run there, whatever the user is looking at. */
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
  try {
    const data = await controller.run(action, parameters);
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
  unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type !== 'browser-control-request') return;
    void handleRequest({
      requestId: event.requestId,
      action: event.action,
      parameters: event.parameters,
      context: event.context,
    });
  });
};

const releaseIfIdle = (): void => {
  if (controllers.size > 0 || sleepingTabs.size > 0 || opener || closer || !unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
};

/**
 * Registers a tab's mounted browser view under its tab id. Unregistering only
 * removes the entry when it still points at the caller, so a stale unmount
 * cannot detach the same tab's newer view.
 */
export const registerBrowserController = (controller: BrowserController): (() => void) => {
  controllers.set(controller.tabId, controller);
  ensureSubscribed();
  return () => {
    if (controllers.get(controller.tabId) === controller) controllers.delete(controller.tabId);
    releaseIfIdle();
  };
};

/**
 * Registers a tab that has no view yet. Unregistering follows the same rule as
 * `registerBrowserController`.
 */
export const registerSleepingBrowserTab = (tab: SleepingBrowserTab): (() => void) => {
  sleepingTabs.set(tab.tabId, tab);
  ensureSubscribed();
  return () => {
    if (sleepingTabs.get(tab.tabId) === tab) sleepingTabs.delete(tab.tabId);
    releaseIfIdle();
  };
};

/**
 * The project on screen, and the browser tab the user is looking at there.
 * A null tab keeps the last one, so switching to a file tab and back does
 * not lose it; a tab left behind in another project no longer counts.
 */
export const setShownBrowserTab = (directory: string, tabId: string | null): void => {
  shownDirectory = directory;
  if (tabId) shownTabId = tabId;
};

/** Registers the app-level fallback that can open a browser tab on demand. */
export const registerBrowserOpener = (open: BrowserOpener): (() => void) => {
  opener = open;
  ensureSubscribed();
  return () => {
    if (opener === open) opener = null;
    releaseIfIdle();
  };
};

/**
 * Registers the panel's ability to close a browser tab. Only a tab the calling
 * session opened is ever passed here, so the panel just performs the close.
 */
export const registerBrowserCloser = (close: BrowserCloser): (() => void) => {
  closer = close;
  ensureSubscribed();
  return () => {
    if (closer === close) closer = null;
    releaseIfIdle();
  };
};
