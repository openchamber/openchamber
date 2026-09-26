// Runs one refresh per key at a time and bounds how many keys refresh at once.
//
// A request that arrives while a refresh for its key is running does not join
// that run: the run may have read the working tree before the change the
// caller just made. Instead the request waits for one follow-up run that starts
// after the current one finishes, so every caller receives a result at least as
// fresh as its own arrival. All requests that arrive during one run share the
// same follow-up, which caps the work per key at "one running, one pending"
// no matter how many callers ask.

export function createSerialRefresh({ maxConcurrent = Number.POSITIVE_INFINITY } = {}) {
  const runs = new Map();
  let running = 0;
  const waiting = [];

  const acquire = () => new Promise((resolve) => {
    if (running < maxConcurrent) {
      running += 1;
      resolve();
      return;
    }
    waiting.push(resolve);
  });

  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    running -= 1;
  };

  const abortError = (signal) => (
    signal?.reason
    || Object.assign(new Error('Git status refresh was cancelled'), { name: 'AbortError' })
  );

  const hasWaiters = (run) => run.waiters.size > 0
    || Boolean(run.follower && run.follower.waiters.size > 0);

  const abortWhenUnused = (run, reason) => {
    if (hasWaiters(run) || run.sourceCompleted || run.sourceAbortRequested) {
      return;
    }
    run.sourceAbortRequested = true;
    run.sourceController.abort(reason);
  };

  const releaseWaiter = (run, waiter) => {
    run.waiters.delete(waiter);
  };

  const waitForRun = (run, signal, owner = run) => {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }

    const waiter = {};
    run.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (method, value) => {
        if (settled) {
          return;
        }
        settled = true;
        releaseWaiter(run, waiter);
        signal?.removeEventListener('abort', onAbort);
        method(value);
      };
      const onAbort = () => {
        releaseWaiter(run, waiter);
        signal?.removeEventListener('abort', onAbort);
        abortWhenUnused(run, signal.reason);
        if (owner !== run) {
          abortWhenUnused(owner, signal.reason);
        }
        finish(reject, abortError(signal));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      run.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
      if (signal?.aborted) {
        onAbort();
      }
    });
  };

  const createRun = (key, requests, execute, pendingRun = null) => {
    const run = pendingRun || {
      follower: null,
      waiters: new Set(),
      sourceController: new AbortController(),
      sourceAbortRequested: false,
      sourceStarted: false,
      sourceCompleted: false,
      promise: null,
      execute,
      requests,
    };
    run.execute = execute;
    run.requests = requests;
    runs.set(key, run);
    const sourcePromise = (async () => {
      await acquire();
      run.sourceStarted = true;
      try {
        return await execute(requests, run.sourceController.signal);
      } finally {
        release();
      }
    })();
    run.sourcePromise = sourcePromise;
    if (pendingRun) {
      sourcePromise.then(run.resolve, run.reject);
    } else {
      run.promise = sourcePromise;
    }
    sourcePromise
      .catch(() => undefined)
      .then(() => {
        run.sourceCompleted = true;
        if (runs.get(key) !== run) return;
        if (run.follower) {
          const follower = run.follower;
          run.follower = null;
          if (follower.waiters.size > 0) {
            createRun(key, follower.requests, follower.execute, follower);
          } else {
            runs.delete(key);
          }
          return;
        }
        runs.delete(key);
      });
    return run;
  };

  return {
    /**
     * @template TRequest, TResult
     * @param {string} key
     * @param {TRequest} request
     * @param {(requests: TRequest[], signal: AbortSignal) => Promise<TResult>} execute
     *   receives every request the run answers and one signal for the shared source
     * @returns {Promise<TResult>}
     */
    run(key, request, execute) {
      if (request?.signal?.aborted) {
        return Promise.reject(abortError(request.signal));
      }
      const current = runs.get(key);
      if (!current) {
        const run = createRun(key, [request], execute);
        return waitForRun(run, request?.signal);
      }
      if (current.follower?.sourceAbortRequested || current.follower?.waiters.size === 0) {
        current.follower = null;
      }
      if (!current.follower) {
        const follower = {
          requests: [],
          execute,
          waiters: new Set(),
          sourceController: new AbortController(),
          sourceAbortRequested: false,
          sourceStarted: false,
          sourceCompleted: false,
          promise: null,
          sourcePromise: null,
          resolve: null,
          reject: null,
        };
        follower.promise = new Promise((resolve, reject) => {
          follower.resolve = resolve;
          follower.reject = reject;
        });
        current.follower = follower;
      }
      current.follower.requests.push(request);
      return waitForRun(current.follower, request?.signal, current);
    },
    /** Keys with a running or pending refresh. Exposed for tests. */
    get activeKeys() {
      return Array.from(runs.keys());
    },
  };
}
