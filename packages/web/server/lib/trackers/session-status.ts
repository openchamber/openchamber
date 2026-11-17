import type { TrackerRegistry, TrackerRuntimeEvent, TrackerSessionStatusRuntime } from './tracker-contract.js';

type LoadingState = { pending: TrackerRuntimeEvent[]; runtime?: never; none?: never; failedAt?: never };
type TrackerState = LoadingState
  | { runtime: TrackerSessionStatusRuntime; pending?: never; none?: never; failedAt?: never }
  | { none: true; pending?: never; runtime?: never; failedAt?: never }
  | { failedAt: number; pending?: never; runtime?: never; none?: never };
type SessionStatusOptions = {
  registry: Pick<TrackerRegistry, 'list' | 'implementation'>;
  now?: () => number;
  retryAfterMs?: number;
  maxPending?: number;
  warn?: (...args: unknown[]) => void;
};
const hasMessage = (value: unknown): value is { message: unknown } => value !== null && value !== undefined && 'message' in Object(value);

export function createTrackerSessionStatus({
  registry,
  now = Date.now,
  retryAfterMs = 30_000,
  maxPending = 200,
  warn = (...args) => console.warn(...args),
}: SessionStatusOptions) {
  const states = new Map<string, TrackerState>();

  const load = (id: string) => {
    const state: LoadingState = { pending: [] };
    states.set(id, state);
    registry.implementation(id).then((tracker) => {
      const createRuntime = tracker?.sessionStatus?.createRuntime;
      if (!(createRuntime instanceof Function)) {
        states.set(id, { none: true });
        return;
      }
      const runtime = createRuntime();
      states.set(id, { runtime });
      for (const payload of state.pending) runtime.processPayload(payload);
    }).catch((error) => {
      states.set(id, { failedAt: now() });
      warn(`[trackers] ${id}: session status runtime did not start:`, error?.message || error);
    });
    return state;
  };

  const forget = (id: string) => {
    const state = states.get(id);
    if (!state) return;
    states.delete(id);
    try {
      state.runtime?.stop?.();
    } catch (error) {
      warn(`[trackers] ${id}: session status runtime did not stop:`, hasMessage(error) ? error.message || error : error);
    }
  };

  const processPayload = (payload: TrackerRuntimeEvent, { spaceId = null }: { spaceId?: string | null } = {}) => {
    if (spaceId) return;
    const current = registry.list();
    for (const id of [...states.keys()]) {
      if (!current.includes(id)) forget(id);
    }
    for (const id of current) {
      const state = states.get(id);
      if (state?.runtime) {
        state.runtime.processPayload(payload);
        continue;
      }
      if (state?.none) continue;
      if (state?.pending) {
        if (state.pending.length < maxPending) state.pending.push(payload);
        continue;
      }
      if (state?.failedAt !== undefined && now() - state.failedAt < retryAfterMs) continue;
      load(id).pending.push(payload);
    }
  };

  return { processPayload, forget };
}
