const isFunction = (value) => /\[object (?:Async)?Function\]/.test(Object.prototype.toString.call(value));

const cancellationError = (signal, message) => (
  signal?.reason
  || Object.assign(new Error(message), { name: 'AbortError' })
);

/**
 * Share one source task while letting each caller leave independently.
 * The source is cancelled only after the last waiter leaves, and its promise
 * remains available to the owner until the task's own cleanup has finished.
 */
export const createSharedRequest = (execute, { cancellationMessage = 'Request was cancelled' } = {}) => {
  if (!isFunction(execute)) {
    throw new TypeError('A shared request source is required');
  }

  const sourceController = new AbortController();
  const entry = {
    sourceSignal: sourceController.signal,
    sourceAbortRequested: false,
    sourceSettled: false,
    waiters: 0,
    promise: null,
    wait: null,
  };

  const abortWhenUnused = (reason) => {
    if (entry.waiters !== 0 || entry.sourceSettled || entry.sourceAbortRequested) {
      return;
    }
    entry.sourceAbortRequested = true;
    sourceController.abort(reason);
  };

  entry.promise = Promise.resolve()
    .then(() => execute(sourceController.signal))
    .finally(() => {
      entry.sourceSettled = true;
    });

  entry.wait = (signal) => {
    if (signal?.aborted) {
      abortWhenUnused(signal.reason);
      return Promise.reject(cancellationError(signal, cancellationMessage));
    }
    if (entry.sourceAbortRequested) {
      return Promise.reject(cancellationError(signal, cancellationMessage));
    }

    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        entry.waiters = Math.max(0, entry.waiters - 1);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        release();
        abortWhenUnused(signal.reason);
        reject(cancellationError(signal, cancellationMessage));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      entry.promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    });
  };

  return entry;
};
