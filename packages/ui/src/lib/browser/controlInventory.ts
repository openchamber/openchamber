/**
 * Publishes this window's browser-controller inventory to the server.
 *
 * Delivery matches every targeted request against what each connected window
 * last reported: the directory it can open tabs in, the controllers it has
 * registered, the tab it is showing, and whether it is focused. A window that
 * never reports is matched by nothing, so this publisher is what makes the
 * window reachable at all.
 *
 * The report must survive reconnects (a reconnect is a brand-new server-side
 * connection with no inventory) and must never lie about a window that went
 * away: the publisher starts with the first controller/opener registration,
 * stops when nothing remains registered, and posts a clearing inventory on
 * stop so the server does not keep routing to stale state. Posts carry a
 * per-window monotonically increasing revision, so a delayed earlier post can
 * never overwrite a newer one server-side.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getBrowserControlClientId,
  isEventStreamConnected,
  subscribeEventStreamReady,
} from '@/lib/openchamberEvents';
import {
  getBrowserControlInventoryState,
  subscribeBrowserControlState,
} from '@/lib/browser/controlClient';

const DEBOUNCE_MS = 100;
const RETRY_DELAYS_MS = [250, 500, 1_000] as const;

let running = false;
let revision = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let dirtyWhileInFlight = false;
let retryAttempt = 0;
let unsubscribeState: (() => void) | null = null;
let unsubscribeReady: (() => void) | null = null;
let focusCleanup: (() => void) | null = null;

type InventoryPost = {
  clientId: string;
  revision: number;
  openableDirectory: string | null;
  controllers: Array<{ directory: string; tabId: string }>;
  activeTarget: { directory: string; tabId: string } | null;
  hasFocus: boolean;
};

const buildInventory = (clearing: boolean): InventoryPost => {
  revision += 1;
  const state = clearing
    ? { openableDirectory: null, controllers: [], activeTarget: null }
    : getBrowserControlInventoryState();
  return {
    clientId: getBrowserControlClientId(),
    revision,
    ...state,
    // Sampled per post: the server prefers the focused window, and focus
    // changes between reports are exactly what the focus/blur re-post covers.
    hasFocus: typeof document !== 'undefined' && typeof document.hasFocus === 'function'
      ? document.hasFocus()
      : false,
  };
};

/** Returns whether the server stored the report; never throws. */
const postInventory = async (inventory: InventoryPost): Promise<boolean> => {
  try {
    const response = await runtimeFetch('/api/browser-control/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inventory),
    });
    if (!response.ok) return false;
    const body = await response.json() as { recorded?: unknown };
    return body?.recorded === true;
  } catch {
    return false;
  }
};

const flush = async (): Promise<void> => {
  if (!running || inFlight) return;
  inFlight = true;
  const recorded = await postInventory(buildInventory(false));
  inFlight = false;
  if (!running) return; // stopped mid-flight; stop already posted the clearing one
  if (dirtyWhileInFlight) {
    // The state moved while the post was unanswered; the newer snapshot wins.
    dirtyWhileInFlight = false;
    schedulePost();
    return;
  }
  if (recorded) {
    retryAttempt = 0;
    return;
  }
  if (retryAttempt < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, delay);
  }
  // Past the retry budget the publisher goes idle until the next change or
  // stream event re-arms it.
};

const schedulePost = (): void => {
  if (!running) return;
  retryAttempt = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (inFlight) {
      dirtyWhileInFlight = true;
      return;
    }
    void flush();
  }, DEBOUNCE_MS);
};

export const startBrowserControlInventory = (): void => {
  if (running) return;
  running = true;
  retryAttempt = 0;
  dirtyWhileInFlight = false;
  unsubscribeState = subscribeBrowserControlState(schedulePost);
  unsubscribeReady = subscribeEventStreamReady(schedulePost);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onFocusChange = () => schedulePost();
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    focusCleanup = () => {
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
    };
  }
  schedulePost();
};

export const stopBrowserControlInventory = (): void => {
  if (!running) return;
  running = false;
  unsubscribeState?.();
  unsubscribeState = null;
  unsubscribeReady?.();
  unsubscribeReady = null;
  focusCleanup?.();
  focusCleanup = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  dirtyWhileInFlight = false;
  retryAttempt = 0;
  // A still-connected window must not keep looking able to serve. When the
  // stream is already gone the server dropped the connection object — and
  // its inventory — with it, so there is nothing to clear.
  if (isEventStreamConnected()) {
    void postInventory(buildInventory(true));
  }
};
