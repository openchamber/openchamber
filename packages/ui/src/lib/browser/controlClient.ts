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
  /** Runs one action and resolves with its JSON-serializable result. */
  readonly run: (action: string, parameters: Record<string, unknown>) => Promise<unknown>;
};

/** Opens a URL when no browser view exists yet. */
export type BrowserOpener = (url: string) => void;

/**
 * How long a freshly opened tab is given to mount its view. A pane appears
 * within a frame or two; this is slack for a busy renderer, not a wait anyone
 * should ever notice.
 */
const VIEW_ATTACH_TIMEOUT_MS = 2_000;
const VIEW_ATTACH_POLL_MS = 50;

let activeController: BrowserController | null = null;
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
const waitForController = async (
  timeoutMs = VIEW_ATTACH_TIMEOUT_MS,
): Promise<BrowserController | null> => {
  const deadline = Date.now() + timeoutMs;
  while (!activeController && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VIEW_ATTACH_POLL_MS));
  }
  return activeController;
};

const handleRequest = async (request: BrowserControlRequest): Promise<void> => {
  const isOpen = request.action === 'browser.open';
  const controller = activeController;

  if (!controller && !(isOpen && opener)) return;

  // Nothing below this line may touch a page without the server's grant.
  if (!await claimRequest(request.requestId)) return;

  try {
    if (isOpen && !controller) {
      const url = typeof request.parameters.url === 'string' ? request.parameters.url : '';
      if (!url) {
        await postResult(request.requestId, { ok: false, error: 'url is required' });
        return;
      }
      opener?.(url);

      const requestedViewport = typeof request.parameters.viewport === 'string'
        ? request.parameters.viewport
        : '';
      if (!requestedViewport || requestedViewport === 'fill') {
        await postResult(request.requestId, { ok: true, data: { url, opened: true } });
        return;
      }

      // The tab was just created, so its view is a few frames away. Waiting for
      // it lets the layout the agent asked for be applied to the page it is
      // opening, rather than to the next call it has to make.
      const attached = await waitForController();
      if (!attached) {
        // Still no view. Reporting a plain success here would leave the agent
        // believing a size it asked for was applied to a page nobody is showing.
        await postResult(request.requestId, {
          ok: true,
          data: {
            url,
            opened: true,
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
        data: { url, opened: true, viewportApplied: true, viewport },
      });
      return;
    }

    const data = await controller!.run(request.action, request.parameters);
    await postResult(request.requestId, { ok: true, data });
  } catch (error) {
    await postResult(request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
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
  if (activeController || opener || !unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
};

/**
 * Registers the mounted browser view. The most recently mounted view wins;
 * unregistering only clears the registry when it still points at the caller,
 * so a stale unmount cannot detach a newer view.
 */
export const registerBrowserController = (controller: BrowserController): (() => void) => {
  activeController = controller;
  ensureSubscribed();
  return () => {
    if (activeController === controller) activeController = null;
    releaseIfIdle();
  };
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
