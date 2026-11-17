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
    get pendingCount() {
      return pending.size;
    },

    request(action, parameters = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, context } = {}) {
      const requestId = typeof createId === 'function' ? createId() : `browser-${Date.now()}-${pending.size}`;
      const boundedTimeout = Math.min(Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const listenerCount = emitRequest({
        requestId,
        action,
        parameters,
        context: {
          directory: context?.directory ?? null,
          sessionId: context?.sessionId ?? null,
        },
      });
      if (!listenerCount) {
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

    claim(requestId) {
      if (typeof requestId !== 'string' || !requestId) return false;
      const entry = pending.get(requestId);
      if (!entry || entry.claimed) return false;
      entry.claimed = true;
      return true;
    },

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

    rejectAll(message) {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { ok: false, message, status: 503 });
      }
    },
  };
};
