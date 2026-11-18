
interface RefreshFollower<Request, Result> {
  requests: Request[];
  execute: (requests: Request[]) => Promise<Result>;
  promise: Promise<Result>;
  resolve: ((value: Result | PromiseLike<Result>) => void) | undefined;
  reject: (<Reason>(reason?: Reason) => void) | undefined;
}

interface RefreshRun<Request, Result> {
  follower: RefreshFollower<Request, Result> | null;
}

export function createSerialRefresh<Request, Result>({ maxConcurrent = Number.POSITIVE_INFINITY } = {}) {
  const runs = new Map<string, RefreshRun<Request, Result>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const acquire = () => new Promise<void>((resolve) => {
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

  const start = (key: string, requests: Request[], execute: (requests: Request[]) => Promise<Result>, deferred?: RefreshFollower<Request, Result>): Promise<Result> => {
    const run: RefreshRun<Request, Result> = { follower: null };
    runs.set(key, run);
    const promise = (async () => {
      await acquire();
      try {
        return await execute(requests);
      } finally {
        release();
      }
    })();
    if (deferred) {
      promise.then(deferred.resolve, deferred.reject);
    }
    promise
      .catch(() => undefined)
      .then(() => {
        if (runs.get(key) !== run) return;
        if (run.follower) {
          const follower = run.follower;
          start(key, follower.requests, follower.execute, follower);
          return;
        }
        runs.delete(key);
      });
    return promise;
  };

  return {
    run(key: string, request: Request, execute: (requests: Request[]) => Promise<Result>) {
      const current = runs.get(key);
      if (!current) {
        return start(key, [request], execute);
      }
      if (!current.follower) {
        let resolve: RefreshFollower<Request, Result>['resolve'];
        let reject: RefreshFollower<Request, Result>['reject'];
        const promise = new Promise<Result>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        current.follower = { requests: [], execute, promise, resolve, reject };
      }
      current.follower.requests.push(request);
      return current.follower.promise;
    },
    get activeKeys() {
      return Array.from(runs.keys());
    },
  };
}
