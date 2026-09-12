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
import { getBrowserControlClientId, subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { dropQueued, runMutatingOperation } from '@/lib/browser/controlCoordinator';
import { startBrowserControlInventory, stopBrowserControlInventory } from '@/lib/browser/controlInventory';
import type { BrowserBackend, BrowserControllerKey, BrowserTarget } from '@/lib/browser/contract';
import { createElectronWebviewBackend } from '@/lib/browser/electronWebviewBackend';

type BrowserControlRequestTarget = {
  readonly directory?: string;
  readonly tabId?: string;
  readonly openCodeSessionId?: string;
};

type BrowserControlRequest = {
  readonly requestId: string;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
  readonly target?: BrowserControlRequestTarget;
};

/** Implemented by the mounted browser pane. */
export type BrowserController = {
  /** Runs one action and resolves with its JSON-serializable result. */
  readonly run: (action: string, parameters: Record<string, unknown>) => Promise<unknown>;
  /** Describes the tab this controller drives (the pane implements it in todo 7). */
  readonly getInfo?: () => { tabId: string; url: string; title: string };
};

/** Identifies one browser pane: one tab of one project on one runtime. */
export type { BrowserControllerKey } from '@/lib/browser/contract';

/** Opens a URL when no browser view exists yet, returning the tab it opened. */
export type BrowserOpener = (url: string) => { tabId: string } | null;

/**
 * How long a freshly opened tab is given to mount its view. A pane appears
 * within a frame or two; this is slack for a busy renderer, not a wait anyone
 * should ever notice.
 */
const VIEW_ATTACH_TIMEOUT_MS = 2_000;
const VIEW_ATTACH_POLL_MS = 50;

/**
 * Actions that change the page or the panel. Everything else the agent can
 * ask for is read-only and must never wait behind a write.
 */
const MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  'browser.open',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.resize',
]);

export type Registration = {
  readonly key: BrowserControllerKey;
  /** Canonical form of the key's directory, for request-scope comparisons. */
  readonly directoryKey: string;
  readonly controller: BrowserController;
};

export const serializeBrowserControllerKey = (key: BrowserControllerKey): string => `${key.runtimeKey}\n${key.directory}\n${key.tabId}`;

/**
 * Request scope is compared in the UI store's directory-key form
 * (useUIStore.ts `normalizeDirectoryPath`), the same form the server
 * canonicalizes into `target.directory`. Keep this mirror in sync with that
 * function.
 */
const canonicalizeDirectory = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

/** The request's directory in canonical form, or null when absent/malformed. */
const canonicalRequestDirectory = (target: BrowserControlRequestTarget | undefined): string | null => {
  const directory = typeof target?.directory === 'string' && target.directory ? target.directory : null;
  return directory ? canonicalizeDirectory(directory) || null : null;
};

const controllers = new Map<string, Registration>();
let activeTargetKey: string | null = null;
const openers = new Map<string, BrowserOpener>();
let unsubscribe: (() => void) | null = null;
const stateListeners = new Set<() => void>();

const emitBrowserControlState = (): void => {
  for (const listener of stateListeners) listener();
};

/**
 * Fires after every registry, opener, and active-target mutation. The
 * controller inventory publisher subscribes to this as its change feed.
 */
export const subscribeBrowserControlState = (listener: () => void): (() => void) => {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
};

/** Points tab-less requests at the tab the user is actually looking at. */
export const setActiveBrowserTarget = (key: BrowserControllerKey | null): void => {
  const serialized = key ? serializeBrowserControllerKey(key) : null;
  if (serialized === activeTargetKey) return;
  activeTargetKey = serialized;
  emitBrowserControlState();
};

export const getActiveBrowserTarget = (): BrowserControllerKey | null => {
  if (!activeTargetKey) return null;
  const parts = activeTargetKey.split('\n');
  if (parts.length !== 3) return null;
  return { runtimeKey: parts[0], directory: parts[1], tabId: parts[2] };
};

/**
 * The registry state the inventory publisher reports to the server, in the
 * canonical directory form the server's target scope arrives in.
 */
export const getBrowserControlInventoryState = (): {
  openableDirectory: string | null;
  controllers: Array<{ directory: string; tabId: string }>;
  activeTarget: { directory: string; tabId: string } | null;
} => {
  const active = getActiveBrowserTarget();
  return {
    openableDirectory: openers.size > 0 ? openers.keys().next().value ?? null : null,
    controllers: [...controllers.values()].map((registration) => ({
      directory: registration.directoryKey,
      tabId: registration.key.tabId,
    })),
    activeTarget: active
      ? { directory: canonicalizeDirectory(active.directory), tabId: active.tabId }
      : null,
  };
};

/**
 * Delivers a result to the server.
 *
 * A dropped result is indistinguishable from an unreachable browser on the
 * agent's side, so a failure here is reported rather than swallowed — that
 * silence is what once turned a missing body parser into an unexplained
 * twenty-second timeout.
 */
/**
 * Requests this client claimed and has not yet settled, by request id. The
 * claim token binds the result to the grant; the coordinator keys let a
 * server-side cancel drop the request's queued work and discard the
 * in-flight result it can no longer deliver.
 */
type ClaimedRequest = {
  readonly claimToken: string;
  readonly keys: Set<string>;
};

const claimedRequests = new Map<string, ClaimedRequest>();

/**
 * Claims currently on the wire, and cancels that beat their responses. The
 * server can grant a claim and settle the request (abort, timeout) before the
 * response returns; a cancel that arrives in that window must not be lost.
 * Both stay bounded: a cancel is remembered only while its claim is in
 * flight, and the claim's finally consumes or discards it.
 */
const claimsInFlight = new Set<string>();
const cancelledRequestIds = new Set<string>();

/**
 * Asks for the exclusive right to perform a request.
 *
 * A refusal is the normal outcome for a client that lost the race, and so is a
 * failure to ask at all: acting without a grant is what this exists to prevent.
 */
const claimRequest = async (requestId: string): Promise<boolean> => {
  claimsInFlight.add(requestId);
  try {
    const response = await runtimeFetch('/api/browser-control/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, clientId: getBrowserControlClientId() }),
    });
    if (!response.ok) return false;
    const body = await response.json() as { granted?: boolean; claimToken?: unknown };
    if (body?.granted !== true || typeof body.claimToken !== 'string' || !body.claimToken) return false;
    // Cancelled while the claim was on the wire: the server already settled
    // the request, so this grant is stale and the work must never start.
    if (cancelledRequestIds.delete(requestId)) return false;
    claimedRequests.set(requestId, { claimToken: body.claimToken, keys: new Set() });
    return true;
  } catch {
    return false;
  } finally {
    claimsInFlight.delete(requestId);
    cancelledRequestIds.delete(requestId);
  }
};

const postResult = async (requestId: string, outcome: { ok: boolean; data?: unknown; error?: string }, claimToken: string): Promise<void> => {
  try {
    const response = await runtimeFetch('/api/browser-control/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, claimToken, ...outcome }),
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
 * Finds the registration a request should run against. A request naming a tab
 * resolves to exactly that tab; a tab-less request resolves to the active
 * target. Fields arriving with the wrong type are dropped, so a malformed
 * target degrades to a tab-less request rather than throwing.
 *
 * Scope is enforced here: a request naming a directory only ever matches a
 * controller registered inside that directory, so an agent's action cannot
 * land in a project it does not belong to.
 */
const resolveRegistration = (target: BrowserControlRequestTarget | undefined): Registration | null => {
  const directory = canonicalRequestDirectory(target);
  const tabId = typeof target?.tabId === 'string' && target.tabId ? target.tabId : null;

  if (tabId) {
    for (const registration of controllers.values()) {
      if (registration.key.tabId !== tabId) continue;
      if (directory && registration.directoryKey !== directory) continue;
      return registration;
    }
    return null;
  }

  if (activeTargetKey) {
    const active = controllers.get(activeTargetKey);
    if (active && (!directory || active.directoryKey === directory)) return active;
  }

  // No active target, no match: a tab-less request is never resolved by
  // registration order. The panel sets the active target to the visible tab.
  return null;
};

/**
 * Waits for a browser view to register itself, or gives up.
 *
 * Polls rather than subscribes because registration is a plain map write made
 * by whichever pane mounts; a callback would have to be maintained by every
 * caller of `registerBrowserController` for one waiter.
 */
const waitForController = async (
  target: BrowserControlRequestTarget | undefined,
  timeoutMs = VIEW_ATTACH_TIMEOUT_MS,
): Promise<Registration | null> => {
  const deadline = Date.now() + timeoutMs;
  let registration = resolveRegistration(target);
  while (!registration && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VIEW_ATTACH_POLL_MS));
    registration = resolveRegistration(target);
  }
  return registration;
};

/**
 * The backend every request executes through. It reads this module's registry
 * through the narrow accessor slice below, so the dispatch layer here keeps
 * claim, coordinator, and result posting while resolution and invocation
 * become backend-neutral. The todo-8 coordinator stays at this dispatch layer
 * exactly once: the backend never wraps an invocation itself.
 */
const backend: BrowserBackend = createElectronWebviewBackend({
  resolveRegistration,
  getOpener: (directoryKey) => openers.get(directoryKey) ?? null,
  listRegistrations: () => [...controllers.values()],
  getActiveTarget: getActiveBrowserTarget,
  canonicalizeDirectory,
});

/**
 * True while this client hosts real webviews, so a tab the opener just created
 * gets a controller a frame later. An iframe host never gets one, and its open
 * results must say so rather than implying follow-up actions will work.
 */
const canHostRichControl = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__)
);

/**
 * Folds the serving tab's identity into a controller's result. Every result
 * names the tab it came from, so a later failure — or a concurrent one — is
 * never mistaken as belonging to another tab.
 */
const withResultTarget = (
  data: unknown,
  target: { directory: string; tabId?: string } | null,
  extra?: Record<string, unknown>,
): unknown => {
  const base: Record<string, unknown> = data && typeof data === 'object' && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>) }
    : { value: data };
  if (extra) Object.assign(base, extra);
  if (target) base.target = target;
  return base;
};

const handleRequest = async (request: BrowserControlRequest): Promise<void> => {
  const isOpen = request.action === 'browser.open';
  const isTabs = request.action === 'browser.tabs';
  const directory = canonicalRequestDirectory(request.target);
  const tabId = typeof request.target?.tabId === 'string' && request.target.tabId ? request.target.tabId : null;

  // browser.tabs reads the registry and never drives a page, so it bypasses
  // both the coordinator and controller resolution: delivery matched this
  // window on the directory alone, and any in-scope controller qualifies it.
  const tabsScope = isTabs && directory
    && [...controllers.values()].some((entry) => entry.directoryKey === directory)
    ? directory
    : null;

  const registration = isTabs ? null : resolveRegistration(request.target);
  const controller = registration?.controller ?? null;

  // The two open paths stay distinct: an open naming a tab navigates that tab
  // through its controller and never reaches the opener; only a tab-less open
  // creates a tab, and only through the opener registered for the request's
  // directory.
  const opener = isOpen && !tabId && directory ? openers.get(directory) ?? null : null;

  if (!tabsScope && !controller && !opener) return;

  // Nothing below this line may touch a page without the server's grant.
  if (!await claimRequest(request.requestId)) return;

  // From here on the request is ours: every coordinator key it touches is
  // recorded so a server-side cancel can drop its queued and in-flight work,
  // and every result goes out bound to the claim token — or, once cancelled,
  // nowhere at all.
  const settleRequest = async (outcome: { ok: boolean; data?: unknown; error?: string }): Promise<void> => {
    const claimed = claimedRequests.get(request.requestId);
    if (!claimed) return;
    claimedRequests.delete(request.requestId);
    await postResult(request.requestId, outcome, claimed.claimToken);
  };
  const runCoordinated = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const claimed = claimedRequests.get(request.requestId);
    // Cancelled between steps: never start another mutation for it.
    if (!claimed) return Promise.reject(new Error('The request was cancelled'));
    claimed.keys.add(key);
    return runMutatingOperation(key, fn);
  };

  // Mutating actions pass through the per-tab coordinator exactly once, here
  // at dispatch: the pane's action adapter stays raw, so nothing can
  // deadlock behind its own queue entry.
  const mutating = MUTATING_ACTIONS.has(request.action);

  // The scope the backend executes against: the raw request target in the
  // contract's shape (directory always present, possibly '' for a legacy
  // unscoped request).
  const target: BrowserTarget = {
    directory: typeof request.target?.directory === 'string' ? request.target.directory : '',
    ...(tabId ? { tabId } : {}),
    ...(typeof request.target?.openCodeSessionId === 'string'
      ? { openCodeSessionId: request.target.openCodeSessionId }
      : {}),
  };

  // The identity every result names: the tab that actually serves the action.
  // A tab-less request names the resolved active tab, so a failure mid-action
  // still says which tab it touched; the open paths move this to the tab they
  // created once the opener reports it.
  let servedTarget: { directory: string; tabId?: string } | null = registration
    ? { directory: registration.key.directory, tabId: registration.key.tabId }
    : directory
      ? { directory }
      : null;

  try {
    if (tabsScope) {
      await settleRequest({
        ok: true,
        data: { tabs: backend.listTabs({ directory: tabsScope }), target: { directory: tabsScope } },
      });
      return;
    }

    if (isOpen && !controller && opener && directory) {
      // A tab-less open has no tab key yet; concurrent opens for one
      // directory serialize under the directory's opener key.
      const openerKey = `${getRuntimeKey()}\n${directory}\n<opener>`;
      const opened = await runCoordinated(
        openerKey,
        () => backend.execute(target, request.action, request.parameters),
      ) as { tabId: string } | null;
      if (!opened) {
        // No tab exists to name: report the scope and invent no tab id.
        await settleRequest({
          ok: false,
          error: 'The browser tab could not be opened here',
          data: { target: { directory } },
        });
        return;
      }
      servedTarget = { directory, tabId: opened.tabId };

      const url = typeof request.parameters.url === 'string' ? request.parameters.url : '';
      const requestedViewport = typeof request.parameters.viewport === 'string'
        ? request.parameters.viewport
        : '';
      if (!requestedViewport || requestedViewport === 'fill') {
        await settleRequest({
          ok: true,
          data: {
            url,
            opened: true,
            tabId: opened.tabId,
            target: servedTarget,
            // No view was waited on: an iframe host never gets one, a webview
            // host attaches one a frame after the tab exists.
            richControl: canHostRichControl(),
          },
        });
        return;
      }

      // The tab was just created, so its view is a few frames away. Waiting
      // for the exact tab the opener reported lets the layout the agent asked
      // for be applied to the page it is opening, rather than to the next
      // call it has to make.
      const attached = await waitForController({ directory, tabId: opened.tabId });
      if (!attached) {
        // Still no view. Reporting a plain success here would leave the agent
        // believing a size it asked for was applied to a page nobody is showing.
        await settleRequest({
          ok: true,
          data: {
            url,
            opened: true,
            tabId: opened.tabId,
            viewportApplied: false,
            note: 'The panel had no browser view yet, so the viewport was not applied. Call browser.resize now that one exists.',
            target: servedTarget,
            richControl: false,
          },
        });
        return;
      }

      // The follow-up resize runs under the new tab's own key.
      const resized = await runCoordinated(
        serializeBrowserControllerKey(attached.key),
        () => backend.execute({ directory, tabId: opened.tabId }, 'browser.resize', { viewport: requestedViewport }),
      );
      const viewport = resized && typeof resized === 'object'
        ? (resized as { viewport?: unknown }).viewport ?? null
        : null;
      await settleRequest({
        ok: true,
        data: {
          url,
          opened: true,
          tabId: opened.tabId,
          viewportApplied: true,
          viewport,
          target: servedTarget,
          richControl: true,
        },
      });
      return;
    }

    const run = () => backend.execute(target, request.action, request.parameters);
    const data = mutating && registration
      ? await runCoordinated(serializeBrowserControllerKey(registration.key), run)
      : await run();
    await settleRequest({
      ok: true,
      data: withResultTarget(data, servedTarget, isOpen ? { richControl: true } : undefined),
    });
  } catch (error) {
    await settleRequest({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(servedTarget ? { data: { target: servedTarget } } : {}),
    });
  }
};

/**
 * The server settled one of this client's claimed requests early (agent
 * abort, execution timeout): drop its queued work, clear the controlling
 * indicator, and let the in-flight action finish with its result discarded —
 * the request is already settled server-side, so a late post would land
 * unmatched by design. A cancel for a request this client never claimed is
 * not its business.
 */
const handleCancel = (requestId: string): void => {
  const claimed = claimedRequests.get(requestId);
  if (claimed) {
    claimedRequests.delete(requestId);
    for (const key of claimed.keys) dropQueued(key);
    return;
  }
  // A cancel that beats the claim response is remembered for that claim; one
  // for a request this client never claimed is another client's to handle.
  if (claimsInFlight.has(requestId)) cancelledRequestIds.add(requestId);
};

const ensureSubscribed = (): void => {
  startBrowserControlInventory();
  if (unsubscribe) return;
  unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type === 'browser-control-cancel') {
      handleCancel(event.requestId);
      return;
    }
    if (event.type !== 'browser-control-request') return;
    void handleRequest({
      requestId: event.requestId,
      action: event.action,
      parameters: event.parameters,
      target: event.target,
    });
  });
};

const releaseIfIdle = (): void => {
  if (controllers.size > 0 || openers.size > 0 || !unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
  stopBrowserControlInventory();
};

/**
 * Registers a mounted browser pane under its key. Registering the same key
 * again replaces the controller; unregistering only clears the entry when it
 * still points at the caller, so a stale unmount cannot detach a newer
 * registration for the same key.
 */
export const registerBrowserController = (
  key: BrowserControllerKey,
  controller: BrowserController,
): (() => void) => {
  const serialized = serializeBrowserControllerKey(key);
  controllers.set(serialized, { key, directoryKey: canonicalizeDirectory(key.directory), controller });
  ensureSubscribed();
  emitBrowserControlState();
  return () => {
    if (controllers.get(serialized)?.controller === controller) {
      controllers.delete(serialized);
      // A dead pane must not keep steering tab-less requests.
      if (activeTargetKey === serialized) activeTargetKey = null;
      emitBrowserControlState();
    }
    releaseIfIdle();
  };
};

/**
 * Registers the app-level fallback that can open a browser tab on demand,
 * scoped to one directory. Registering the same directory again replaces the
 * opener; unregistering only clears the entry when it still points at the
 * caller, so a stale effect cleanup cannot detach a newer registration.
 */
export const registerBrowserOpener = (directory: string, open: BrowserOpener): (() => void) => {
  const directoryKey = canonicalizeDirectory(directory);
  if (!directoryKey) return () => {};
  openers.set(directoryKey, open);
  ensureSubscribed();
  emitBrowserControlState();
  return () => {
    if (openers.get(directoryKey) === open) {
      openers.delete(directoryKey);
      emitBrowserControlState();
    }
    releaseIfIdle();
  };
};
