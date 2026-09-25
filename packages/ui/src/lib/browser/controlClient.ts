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
 * Every browser tab registers its view under the tab's id. An action with a
 * `tabId` goes to that tab; without one it goes to the tab the user last
 * looked at, never to whichever view happened to register last. Acting in a
 * background tab does not switch the user to it. Snapshots list every tab
 * with its id so the agent can name one.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

type BrowserControlRequest = {
  readonly requestId: string;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
};

/** Implemented by the mounted browser pane. */
export type BrowserController = {
  /** The browser tab this view belongs to; the id agents pass as `tabId`. */
  readonly tabId: string;
  /** What the tab shows now, for the tab list in snapshots. */
  readonly describe: () => { title: string; url: string };
  /** Runs one action and resolves with its JSON-serializable result. */
  readonly run: (action: string, parameters: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Opens a URL in a new background tab for the agent and returns that tab's id,
 * or null when this client has nowhere to open one.
 */
export type BrowserOpener = (url: string) => string | null;

/**
 * How long a freshly opened tab is given to mount its view. A pane appears
 * within a frame or two; this is slack for a busy renderer, not a wait anyone
 * should ever notice.
 */
const VIEW_ATTACH_TIMEOUT_MS = 2_000;
const VIEW_ATTACH_POLL_MS = 50;

/**
 * A client that does not have the tab an action names waits this long before
 * claiming it to answer "no such tab", so the client that has it wins the claim.
 */
const UNKNOWN_TAB_CLAIM_DELAY_MS = 400;

/** Mounted views by tab id, in registration order. */
const controllers = new Map<string, BrowserController>();
/** The browser tab the user last had in front of them. */
let shownTabId: string | null = null;
let opener: BrowserOpener | null = null;
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

/** The tab the user is looking at, else the most recently registered one. */
const defaultController = (): BrowserController | null => {
  const shown = shownTabId ? controllers.get(shownTabId) : undefined;
  if (shown) return shown;
  let last: BrowserController | null = null;
  for (const controller of controllers.values()) last = controller;
  return last;
};

const listTabs = (): Array<{ id: string; title: string; url: string; active: boolean }> => {
  const active = defaultController();
  return [...controllers.values()].map((controller) => {
    let described = { title: '', url: '' };
    try {
      described = controller.describe();
    } catch {
      // A view that cannot say what it shows is still a tab the agent may name.
    }
    return { id: controller.tabId, title: described.title, url: described.url, active: controller === active };
  });
};

const unknownTabError = (tabId: string): string => (
  `There is no browser tab with id ${tabId}. Call browser.snapshot to list the open tabs, or omit tabId to use the tab the user is looking at.`
);

const handleRequest = async (request: BrowserControlRequest): Promise<void> => {
  const isOpen = request.action === 'browser.open';
  const { tabId: rawTabId, ...parameters } = request.parameters;
  const tabId = rawTabId === undefined ? null : String(rawTabId);

  if (tabId !== null) {
    const named = controllers.get(tabId);
    if (!named) {
      // Another client may have this tab: let it claim first, and answer
      // "no such tab" only if nobody did, instead of leaving the agent to time out.
      if (controllers.size === 0 && !opener) return;
      await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TAB_CLAIM_DELAY_MS));
      if (controllers.has(tabId)) {
        await runOnTab(request, controllers.get(tabId)!, parameters);
        return;
      }
      if (!await claimRequest(request.requestId)) return;
      await postResult(request.requestId, { ok: false, error: unknownTabError(tabId) });
      return;
    }
    await runOnTab(request, named, parameters);
    return;
  }

  const controller = defaultController();
  if (!controller && !(isOpen && opener)) return;

  // Nothing below this line may touch a page without the server's grant.
  if (!await claimRequest(request.requestId)) return;

  try {
    // Opening a page without naming a tab makes a new background tab, so the
    // agent never replaces the page the user is on; the id comes back with
    // the answer and the agent keeps working in that tab.
    const url = typeof request.parameters.url === 'string' ? request.parameters.url : '';
    if (isOpen && !url) {
      await postResult(request.requestId, { ok: false, error: 'url is required' });
      return;
    }
    const openedTabId = isOpen && opener ? opener(url) : null;
    if (isOpen && !openedTabId && !controller) {
      await postResult(request.requestId, { ok: false, error: 'There is no browser here to open the page in.' });
      return;
    }
    if (openedTabId) {

      const requestedViewport = typeof request.parameters.viewport === 'string'
        ? request.parameters.viewport
        : '';
      if (!requestedViewport || requestedViewport === 'fill') {
        await postResult(request.requestId, { ok: true, data: { url, opened: true, tabId: openedTabId } });
        return;
      }

      // The tab was just created, so its view is a few frames away. Waiting for
      // it lets the layout the agent asked for be applied to the page it is
      // opening, rather than to the next call it has to make.
      const attached = await waitForTab(openedTabId);
      if (!attached) {
        // Still no view. Reporting a plain success here would leave the agent
        // believing a size it asked for was applied to a page nobody is showing.
        await postResult(request.requestId, {
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

      const resized = await attached.run('browser.resize', { viewport: requestedViewport });
      const viewport = resized && typeof resized === 'object'
        ? (resized as { viewport?: unknown }).viewport ?? null
        : null;
      await postResult(request.requestId, {
        ok: true,
        data: { url, opened: true, tabId: openedTabId, viewportApplied: true, viewport },
      });
      return;
    }

    await postResult(request.requestId, await runAction(controller!, request.action, parameters));
  } catch (error) {
    await postResult(request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** An action that named its tab: claimed and run there, whatever the user is looking at. */
const runOnTab = async (
  request: BrowserControlRequest,
  controller: BrowserController,
  parameters: BrowserControlRequest['parameters'],
): Promise<void> => {
  if (!await claimRequest(request.requestId)) return;
  await postResult(request.requestId, await runAction(controller, request.action, parameters));
};

const runAction = async (
  controller: BrowserController,
  action: string,
  parameters: BrowserControlRequest['parameters'],
): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
  try {
    const data = await controller.run(action, parameters);
    if (action === 'browser.snapshot' && Object(data) === data) {
      return { ok: true, data: { ...Object(data), tabs: listTabs() } };
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
    });
  });
};

const releaseIfIdle = (): void => {
  if (controllers.size > 0 || opener || !unsubscribe) return;
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

/** The browser tab the user has in front of them; actions without a `tabId` go there. */
export const setShownBrowserTab = (tabId: string): void => {
  shownTabId = tabId;
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
