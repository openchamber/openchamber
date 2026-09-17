/**
 * Request/response broker between the agent tool and the in-app browser.
 *
 * The browser lives in the renderer, not the server, so the server cannot act
 * on a page directly. It publishes a request over the existing OpenChamber
 * event stream and waits for the client that owns the browser view to post the
 * result back.
 *
 * The request goes to every client whose reported inventory matches the
 * request's target scope. Exactly one must act on it, so a client claims the
 * request before touching anything and only the first claim from a delivered
 * client is granted. The grant returns a one-time token the result must carry
 * back, so a losing race's late post — or a post from a client that was never
 * delivered the request — settles nothing. Without that, two connected desktop
 * clients would both click, and the losing one's late result would not undo
 * what it had already done.
 *
 * Two failure modes matter and are handled explicitly rather than as timeouts:
 *
 * - No client is listening. The agent is told immediately that the browser is
 *   not open, instead of blocking for the full timeout and then reporting
 *   something ambiguous. One exception: a window that connected but has not
 *   posted its first inventory yet cannot be matched, so a zero-match
 *   delivery waits briefly for inventories to arrive before giving up — a
 *   reconnecting window must not turn into a spurious "not here".
 * - The request was delivered but never claimed: the window's inventory was
 *   stale or its pane crashed between report and delivery. A short claim
 *   window settles this as an honest 503 instead of holding the agent to the
 *   full execution timeout. Once claimed, the execution timeout is unchanged.
 *
 * When a claimed request settles early — the agent aborted, or the execution
 * timeout fired — the eligible windows are sent a one-off cancel event so the
 * claimant can drop queued work and discard the in-flight result it can no
 * longer deliver.
 */

import crypto from 'crypto';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_INVENTORY_WAIT_MS = 2_000;
const DEFAULT_CLAIM_WINDOW_MS = 3_000;

/**
 * The target a client names on a failure post: the tab the action actually ran
 * against, which a tab-less request only learns at resolution time. This is
 * network input, so only a plain { directory, tabId? } passes; anything else
 * drops to the request's own scope.
 */
const reportedResultTarget = (result) => {
  const reported = result?.data?.target;
  if (!reported || typeof reported !== 'object') return undefined;
  const directory = typeof reported.directory === 'string' && reported.directory ? reported.directory : null;
  if (!directory) return undefined;
  const tabId = typeof reported.tabId === 'string' && reported.tabId ? reported.tabId : null;
  return tabId ? { directory, tabId } : { directory };
};

export class BrowserControlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BrowserControlError';
    this.status = status;
  }
}

export const createBrowserControlBroker = ({
  emitRequest,
  createId,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onInventoryUpdated,
  hasPendingInventory,
  inventoryWaitMs = DEFAULT_INVENTORY_WAIT_MS,
  claimWindowMs = DEFAULT_CLAIM_WINDOW_MS,
  emitCancel,
  // Optional copy override for the no-client 503: returns the message to use,
  // or a non-string to keep the default. Wired when the server browser backend
  // exists so the stale 'only the desktop app' text never describes a server
  // that can browse on its own.
  getNoClientMessage,
} = {}) => {
  if (typeof emitRequest !== 'function') {
    throw new TypeError('emitRequest is required');
  }

  const pending = new Map();

  const settle = (requestId, outcome, { cancel = false } = {}) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimer(entry.timer);
    clearTimer(entry.claimTimer);
    // A claimed request settling early means its claimant may be mid-action on
    // a page, so the eligible windows are told to stand down. A result posted
    // through resolve() is a normal completion, not a cancel.
    if (cancel && entry.claimed && typeof emitCancel === 'function') {
      emitCancel({ requestId, eligibleClientIds: entry.eligibleClientIds });
    }
    entry.finish(outcome);
    return true;
  };

  /**
   * Resolves true when an inventory update arrives, false when the remaining
   * wait budget or the caller's abort ends it first.
   */
  const waitForInventoryUpdate = (remainingMs, signal) => new Promise((resolveWait) => {
    let done = false;
    let unsubscribe = null;
    const finishWait = (woke) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbortWait);
      resolveWait(woke);
    };
    const onAbortWait = signal ? () => finishWait(false) : null;
    unsubscribe = onInventoryUpdated(() => finishWait(true));
    const timer = setTimer(() => finishWait(false), remainingMs);
    if (signal) signal.addEventListener('abort', onAbortWait, { once: true });
  });

  return {
    /** Number of requests still awaiting a client response. */
    get pendingCount() {
      return pending.size;
    },

    /** The clients a pending request was delivered to, while it is pending. */
    getEligibleClientIds(requestId) {
      return pending.get(requestId)?.eligibleClientIds;
    },

    /**
     * Publishes one browser action and resolves with the client's result.
     * Rejects with a BrowserControlError the agent can act on.
     */
    request(action, parameters = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, target } = {}) {
      const requestId = typeof createId === 'function' ? createId() : `browser-${Date.now()}-${pending.size}`;
      const boundedTimeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

      // The scope a request was issued for travels with it, so every failure
      // the broker produces can name the target it never reached. A client's
      // own failure post refines it to the tab the action actually ran against.
      const scopedError = (message, status, reportedTarget, code) => {
        const error = new BrowserControlError(message, status);
        const effectiveTarget = reportedTarget ? { ...target, ...reportedTarget } : target;
        if (effectiveTarget !== undefined) error.target = effectiveTarget;
        // 'no-client' marks the unserved-gap failure so a merging caller can
        // tell it apart from a real client-side failure.
        if (code) error.code = code;
        return error;
      };

      const payload = { requestId, action, parameters, target };

      return new Promise((resolve, reject) => {
const finish = (outcome) => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          if (outcome.ok) resolve(outcome.data ?? null);
else reject(scopedError(outcome.message || 'Browser action failed', outcome.status || 400, outcome.target, outcome.code));
};

        const onAbort = signal
          ? () => settle(requestId, { ok: false, message: 'Browser action was cancelled', status: 499 }, { cancel: true })
          : null;
        if (signal) {
          if (signal.aborted) {
            reject(scopedError('Browser action was cancelled', 499));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimer(() => {
          settle(requestId, {
            ok: false,
            message: `The in-app browser did not respond within ${Math.round(boundedTimeout / 1000)}s`,
            status: 504,
          }, { cancel: true });
        }, boundedTimeout);

        pending.set(requestId, {
          finish,
          timer,
          claimTimer: null,
          claimed: false,
          claimantClientId: null,
          claimToken: null,
          target,
          eligibleClientIds: [],
        });

        void (async () => {
          let delivery = emitRequest(payload);

          // A zero match with identified-but-inventory-less connections means
          // the serving window may simply not have reported yet. Re-match on
          // every posted inventory, in a loop: an unrelated window posting
          // first must not end the wait while the right one is still coming.
          const canAwaitInventory = typeof onInventoryUpdated === 'function'
            && typeof hasPendingInventory === 'function';
          if (delivery.delivered === 0 && canAwaitInventory && !signal?.aborted) {
            const deadline = Date.now() + inventoryWaitMs;
            while (delivery.delivered === 0 && hasPendingInventory()) {
              if (signal?.aborted || !pending.has(requestId)) return;
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              if (!await waitForInventoryUpdate(remaining, signal)) break;
              if (!pending.has(requestId)) return;
              delivery = emitRequest(payload);
            }
          }

          const entry = pending.get(requestId);
          if (!entry) return; // settled while waiting (abort or timeout)
          if (delivery.delivered > 0) {
            entry.eligibleClientIds = delivery.eligibleClientIds;
            // Delivered but never claimed means the window cannot actually
            // serve it (stale inventory, crashed pane): fail fast instead of
            // holding the agent to the execution timeout. Claiming clears
            // this timer; the post-claim execution timeout is unchanged.
            entry.claimTimer = setTimer(() => {
              entry.claimTimer = null;
              if (entry.claimed || !pending.has(requestId)) return;
              settle(requestId, {
                ok: false,
                message: target?.directory
                  ? `The browser panel for ${target.directory} received the request but no connected `
                    + `window started it within ${Math.round(claimWindowMs / 1000)}s. Nothing was changed.`
                  : 'A connected OpenChamber window received the browser request but none started it '
                    + 'in time. Nothing was changed.',
                status: 503,
              });
            }, claimWindowMs);
            return;
          }

          const injectedNoClientMessage = typeof getNoClientMessage === 'function' ? getNoClientMessage(target) : null;
          settle(requestId, {
            ok: false,
            message: (typeof injectedNoClientMessage === 'string' && injectedNoClientMessage)
              || (target?.directory
                ? `No connected OpenChamber window can serve the browser panel for ${target.directory}. `
                  + 'Nothing was changed.'
                // Written for the agent reading it, not the user: state what this
                // environment can do, and leave deciding whether it matters to
                // the caller rather than handing it an instruction it cannot
                // carry out.
                : 'No OpenChamber client connected here can control a page. Reading and '
                  + 'interacting with a page works when OpenChamber runs as its desktop '
                  + 'application; a web browser tab can display a page but cannot be '
                  + 'driven. Nothing was changed. Mention this to the user only if it '
                  + 'affects what they asked for.'),
            status: 503,
            code: 'no-client',
          });
        })();
      });
    },

    /**
     * Grants the right to perform one request, to one client.
     *
     * The first caller the request was actually delivered to wins and gets a
     * one-time claim token its result must carry back; everyone else — the
     * losing race, a client outside the delivered set, a settled request — is
     * told no and must do nothing.
     */
    claim(requestId, clientId) {
      if (typeof requestId !== 'string' || !requestId) return { granted: false };
      if (typeof clientId !== 'string' || !clientId) return { granted: false };
      const entry = pending.get(requestId);
      if (!entry || entry.claimed) return { granted: false };
      if (!entry.eligibleClientIds.includes(clientId)) return { granted: false };
      clearTimer(entry.claimTimer);
      entry.claimTimer = null;
      entry.claimed = true;
      entry.claimantClientId = clientId;
      entry.claimToken = crypto.randomUUID();
      return { granted: true, claimToken: entry.claimToken };
    },

    /**
     * Accepts a result posted by the claiming client. Returns false for an
     * unknown id, a request that was never claimed, or a mismatched claim
     * token — all normal outcomes for a response that lost a race, and none
     * of them may settle the request.
     */
    resolve(requestId, result, claimToken) {
      if (typeof requestId !== 'string' || !requestId) return false;
      const entry = pending.get(requestId);
      if (!entry || !entry.claimed) return false;
      if (typeof claimToken !== 'string' || claimToken !== entry.claimToken) return false;
      if (result && result.ok === true) {
        return settle(requestId, { ok: true, data: result.data ?? null });
      }
      return settle(requestId, {
        ok: false,
        message: typeof result?.error === 'string' && result.error ? result.error : 'Browser action failed',
        status: 400,
        target: reportedResultTarget(result),
      });
    },

    /** Fails everything in flight, e.g. when the owning client disconnects. */
    rejectAll(message) {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { ok: false, message, status: 503 }, { cancel: true });
      }
    },
  };
};
