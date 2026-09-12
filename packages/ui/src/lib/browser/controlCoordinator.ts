/**
 * Minimal user/agent operation coordinator for browser control.
 *
 * Mutating agent actions on a tab serialize behind one another here, and a
 * host-observable user action on the pane (address typing, navigation,
 * back/forward/reload, viewport change, annotation start) bumps the tab's
 * generation. An op records the generation when it STARTS; when it settles
 * against a newer generation its result is discarded and its caller receives
 * the conflict error below, which tells the agent to retry. Read-only actions
 * never enter this queue.
 *
 * Abort/disconnect semantics: an agent abort settles server-side (499) and
 * the cancel event (todo 5) calls `dropQueued`, which removes not-yet-started
 * ops and clears the controlling state; an in-flight op cannot be killed, so
 * it finishes and its result is discarded the same way. The coordinator is
 * client-local — there is nothing else to release on disconnect.
 *
 * LIMITATION: input typed or clicked INSIDE the page is not observable from
 * the host renderer — the coordinator sees panel chrome actions only. Closing
 * that hole would require an Electron preload bridge, which is out of scope.
 */

const USER_CONFLICT_MESSAGE = 'The user interacted with this tab while the action ran; retry the action';
const DROPPED_MESSAGE = 'The queued action was dropped';

type QueuedOperation = {
  /** Runs the op's fn and settles its promise. Invoked only when its turn comes. */
  readonly start: () => void;
  /** Settles the op's promise without ever running fn. */
  readonly drop: () => void;
};

type KeyState = {
  /** Bumped by every user action; ops snapshot it at start and compare at settle. */
  generation: number;
  /** An op has started and not yet settled. */
  running: boolean;
  /** Visible through `isAgentControlling`; `dropQueued` clears it immediately. */
  controlling: boolean;
  readonly queue: QueuedOperation[];
};

const states = new Map<string, KeyState>();
const listeners = new Set<() => void>();

const emitAgentControl = (): void => {
  for (const listener of listeners) listener();
};

/** Fires whenever any key's controlling flag flips, for the pane's indicator. */
export const subscribeAgentControl = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const isAgentControlling = (key: string): boolean => states.get(key)?.controlling === true;

const pump = (key: string, state: KeyState): void => {
  if (state.running) return;
  const next = state.queue.shift();
  if (!next) {
    // Drained: the key keeps no state between operations.
    if (state.controlling) {
      state.controlling = false;
      emitAgentControl();
    }
    states.delete(key);
    return;
  }
  state.running = true;
  next.start();
};

/**
 * Queues `fn` behind other mutating ops for the key and resolves with its
 * result — unless the user touched the tab while it ran, in which case the
 * result is discarded and the promise rejects with the conflict error.
 */
export const runMutatingOperation = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  let state = states.get(key);
  if (!state) {
    state = { generation: 0, running: false, controlling: false, queue: [] };
    states.set(key, state);
  }
  const current = state;
  const promise = new Promise<T>((resolve, reject) => {
    const start = (): void => {
      if (!current.controlling) {
        current.controlling = true;
        emitAgentControl();
      }
      const generationAtStart = current.generation;
      void (async () => {
        try {
          const result = await fn();
          if (current.generation !== generationAtStart) {
            reject(new Error(USER_CONFLICT_MESSAGE));
            return;
          }
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          current.running = false;
          pump(key, current);
        }
      })();
    };
    current.queue.push({
      start,
      drop: () => reject(new Error(DROPPED_MESSAGE)),
    });
  });
  pump(key, current);
  return promise;
};

/**
 * Records a user action on the tab: any op that started before this and is
 * still running will discard its result with the conflict error. A no-op
 * when nothing is coordinating the key.
 */
export const noteUserAction = (key: string): void => {
  const state = states.get(key);
  if (state) state.generation += 1;
};

/**
 * Removes not-yet-started ops for the key and clears its controlling state
 * (the cancel path calls this). An in-flight op is left to finish; its
 * generation bump makes the caller discard the result. A no-op on an
 * already-empty queue.
 */
export const dropQueued = (key: string): void => {
  const state = states.get(key);
  if (!state) return;
  const queued = state.queue.splice(0);
  // Invalidates the in-flight op so its result is discarded on settle.
  state.generation += 1;
  for (const op of queued) op.drop();
  if (state.controlling) {
    state.controlling = false;
    emitAgentControl();
  }
  if (!state.running) states.delete(key);
};
