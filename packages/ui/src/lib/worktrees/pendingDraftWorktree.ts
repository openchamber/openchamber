type Deferred = {
  promise: Promise<string>;
  resolve: (directory: string) => void;
  reject: (error: Error) => void;
};

const requests = new Map<string, Deferred>();
const settled = new Map<string, string>();
// Requests rejected with `keep`: a send that starts waiting late still gets the real reason.
const failed = new Map<string, Error>();

const createDeferred = (): Deferred => {
  let resolve!: (directory: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const createId = (): string => `worktree_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const createPendingDraftWorktreeRequest = (): string => {
  const id = createId();
  requests.set(id, createDeferred());
  return id;
};

export const resolvePendingDraftWorktreeRequest = (id: string, directory: string, options?: { keep?: boolean }): void => {
  const entry = requests.get(id);
  if (!entry) {
    return;
  }
  requests.delete(id);
  if (options?.keep) settled.set(id, directory);
  entry.resolve(directory);
};

export const rejectPendingDraftWorktreeRequest = (id: string, error: Error, options?: { keep?: boolean }): void => {
  const entry = requests.get(id);
  if (!entry) {
    return;
  }
  requests.delete(id);
  if (options?.keep) {
    failed.set(id, error);
    // Nobody may be waiting yet; the late waiter reads `failed` instead.
    entry.promise.catch(() => undefined);
  }
  entry.reject(error);
};

export const waitForPendingDraftWorktreeRequest = (id: string): Promise<string> => {
  const done = settled.get(id);
  if (done !== undefined) return Promise.resolve(done);
  const error = failed.get(id);
  if (error) return Promise.reject(error);
  const entry = requests.get(id);
  if (!entry) {
    return Promise.reject(new Error('Pending worktree request not found'));
  }
  return entry.promise;
};

const awaited = new Set<string>();
const awaitedListeners = new Set<() => void>();

export const noteDraftSendWaiting = (id: string, waiting: boolean): void => {
  if (waiting === awaited.has(id)) return;
  if (waiting) awaited.add(id);
  else awaited.delete(id);
  for (const listener of awaitedListeners) listener();
};

export const isDraftSendWaiting = (id: string | null | undefined): boolean => Boolean(id && awaited.has(id));

export const subscribeDraftSendWaiting = (listener: () => void): (() => void) => {
  awaitedListeners.add(listener);
  return () => { awaitedListeners.delete(listener); };
};
