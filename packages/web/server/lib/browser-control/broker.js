/**
 * Request/response broker between the agent tool and the in-app browser.
 *
 * The browser lives in the renderer, not the server, so the server cannot act
 * on a page directly. It publishes a request over the existing OpenChamber
 * event stream and waits for the client that owns the browser view to post the
 * result back.
 *
 * The request goes to every client that could serve it, because the server
 * cannot know which one is showing a page. Exactly one must act on it, so a
 * client claims the request before touching anything and only the first claim
 * is granted. Without that, two connected desktop clients would both click, and
 * the losing one's late result would not undo what it had already done.
 *
 * Two failure modes matter and are handled explicitly rather than as timeouts:
 *
 * - No client is listening. The agent is told immediately that the browser is
 *   not open, instead of blocking for the full timeout and then reporting
 *   something ambiguous.
 * - The client accepted the request and then went away. That still times out,
 *   because the alternative — assuming success — would be a lie.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

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
} = {}) => {
  if (typeof emitRequest !== 'function') {
    throw new TypeError('emitRequest is required');
  }

  const pending = new Map();

  const settle = (requestId, outcome) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimer(entry.timer);
    entry.finish(outcome);
    return true;
  };

  return {
    /** Number of requests still awaiting a client response. */
    get pendingCount() {
      return pending.size;
    },

    /**
     * Publishes one browser action and resolves with the client's result.
     * Rejects with a BrowserControlError the agent can act on.
     */
    request(action, parameters = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
      const requestId = typeof createId === 'function' ? createId() : `browser-${Date.now()}-${pending.size}`;
      const boundedTimeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const listenerCount = emitRequest({ requestId, action, parameters });
      if (!listenerCount) {
        // Written for the agent reading it, not the user: state what this
        // environment can do, and leave deciding whether it matters to the
        // caller rather than handing it an instruction it cannot carry out.
        return Promise.reject(new BrowserControlError(
          'No OpenChamber client connected here can control a page. Reading and '
          + 'interacting with a page works when OpenChamber runs as its desktop '
          + 'application; a web browser tab can display a page but cannot be '
          + 'driven. Nothing was changed. Mention this to the user only if it '
          + 'affects what they asked for.',
          503,
        ));
      }

      return new Promise((resolve, reject) => {
        const finish = (outcome) => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          if (outcome.ok) resolve(outcome.data ?? null);
          else reject(new BrowserControlError(outcome.message || 'Browser action failed', outcome.status || 400));
        };

        const onAbort = signal
          ? () => settle(requestId, { ok: false, message: 'Browser action was cancelled', status: 499 })
          : null;
        if (signal) {
          if (signal.aborted) {
            reject(new BrowserControlError('Browser action was cancelled', 499));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimer(() => {
          settle(requestId, {
            ok: false,
            message: `The in-app browser did not respond within ${Math.round(boundedTimeout / 1000)}s`,
            status: 504,
          });
        }, boundedTimeout);

        pending.set(requestId, { finish, timer, claimed: false });
      });
    },

    /**
     * Grants the right to perform one request, to one client.
     *
     * The first caller wins; everyone else is told no and must do nothing. An
     * unknown id is also a refusal: the request has already been settled, and
     * acting on it now would change a page nobody is waiting on.
     */
    claim(requestId) {
      if (typeof requestId !== 'string' || !requestId) return false;
      const entry = pending.get(requestId);
      if (!entry || entry.claimed) return false;
      entry.claimed = true;
      return true;
    },

    /**
     * Accepts a result posted by the client. Returns false for an unknown id,
     * which is the normal outcome for a response that lost a race with the
     * timeout and must not be treated as an error.
     */
    resolve(requestId, result) {
      if (typeof requestId !== 'string' || !requestId) return false;
      if (result && result.ok === true) {
        return settle(requestId, { ok: true, data: result.data ?? null });
      }
      return settle(requestId, {
        ok: false,
        message: typeof result?.error === 'string' && result.error ? result.error : 'Browser action failed',
        status: 400,
      });
    },

    /** Fails everything in flight, e.g. when the owning client disconnects. */
    rejectAll(message) {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { ok: false, message, status: 503 });
      }
    },
  };
};
