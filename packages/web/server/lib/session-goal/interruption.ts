import { isSessionNotFound, type MetadataDecider, type SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { SessionGoal } from './runtime.js';

type GoalUpdate = (metadata: SessionMetadata | null | undefined) => SessionGoal | null;
export type PersistSessionGoal = (
  sessionId: string,
  directory: string,
  goal: SessionGoal | { update: GoalUpdate },
  canWrite?: ((metadata: SessionMetadata | null | undefined) => boolean) | null,
) => Promise<SessionMetadata | boolean | void>;

export interface GoalTick {
  goalId?: string;
  replaced?: boolean;
  aborted?: boolean;
}

interface PersistenceAttempt {
  goalId: string | null;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  run: () => Promise<void>;
}

export const createGoalPersistence = (
  persistPatch: (sessionId: string, patch: SessionMetadata, options: { directory: string }) => Promise<SessionMetadata | void>,
  updateMetadata: (sessionId: string, decide: MetadataDecider, options: { directory: string }) => Promise<{ changed: boolean }>,
): PersistSessionGoal =>
  async (sessionId, directory, goal, canWrite) => {
    if (!('update' in goal) && !canWrite) {
      return persistPatch(sessionId, { openchamber: { goal } }, { directory });
    }
    const result = await updateMetadata(sessionId, (metadata) => {
      const next = 'update' in goal ? goal.update(metadata) : canWrite?.(metadata) && goal;
      return next ? { openchamber: { goal: next } } : null;
    }, { directory });
    return result.changed;
  };

export const createGoalInterruptions = ({ persistSessionGoal, parseGoalMetadata, recheckMs, onSettled }: {
  persistSessionGoal: PersistSessionGoal | null;
  parseGoalMetadata: (session: { metadata: SessionMetadata | null | undefined }) => SessionGoal | null;
  recheckMs: number;
  onSettled: (sessionId: string) => void;
}) => {
  const pauses = new Map<string, PersistenceAttempt>();
  const rollbacks = new Map<string, PersistenceAttempt>();
  const activeTicks = new Map<string, GoalTick>();
  const busy = new Set<string>();
  const stopsInFlight = new Set<string>();
  const supersededStops = new Set<string>();
  let stopped = false;

  const cancel = (attempts: Map<string, PersistenceAttempt>, sessionId: string) => {
    clearTimeout(attempts.get(sessionId)?.timer);
    attempts.delete(sessionId);
  };

  const persist = (attempts: Map<string, PersistenceAttempt>, sessionId: string, directory: string,
    goalId: string | null, update: (goal: SessionGoal | null) => SessionGoal | null, failure: string) => {
    cancel(attempts, sessionId);
    if (!persistSessionGoal) return;
    const isCurrent = () => attempts.get(sessionId) === attempt;
    const run = async () => {
      attempt.running = true;
      try {
        await persistSessionGoal(sessionId, directory, {
          update: (metadata) => isCurrent() ? update(parseGoalMetadata({ metadata })) : null,
        });
      } catch (error) {
        console.warn(`[session-goal] ${failure}:`, error instanceof Error ? error.message : error);
        if (!isCurrent()) return;
        if (stopped || isSessionNotFound(error)) {
          cancel(attempts, sessionId);
          return;
        }
        attempt.running = false;
        attempt.timer = setTimeout(run, recheckMs);
        attempt.timer.unref?.();
        return;
      }
      if (!isCurrent()) return;
      cancel(attempts, sessionId);
      if (!stopped) onSettled(sessionId);
    };
    const attempt: PersistenceAttempt = { goalId, running: false, timer: undefined, run };
    attempts.set(sessionId, attempt);
    void run();
  };

  const pause = (sessionId: string, directory: string) => {
    const tick = activeTicks.get(sessionId);
    if (tick) tick.aborted = true;
    persist(pauses, sessionId, directory, null, (goal) => {
      if (goal?.status !== 'active') return null;
      return { ...goal, status: 'paused', statusReason: 'paused after abort', updatedAt: Date.now() };
    }, 'pause after abort failed');
  };

  const rollback = (sessionId: string, directory: string, written: SessionGoal) => {
    persist(rollbacks, sessionId, directory, written.id, (goal) => {
      if (goal?.id !== written.id || goal.turnsUsed !== written.turnsUsed) return null;
      return { ...goal, turnsUsed: goal.turnsUsed - 1, updatedAt: Date.now() };
    }, 'continuation accounting rollback failed');
  };

  const sendReserved = async ({ sessionId, directory, written, attempt, confirmTail, isCurrent, send }: {
    sessionId: string;
    directory: string;
    written: SessionGoal;
    attempt: GoalTick;
    confirmTail: () => Promise<boolean>;
    isCurrent: () => boolean;
    send: () => Promise<void>;
  }) => {
    let sent = false;
    try {
      if (!await confirmTail() || !isCurrent()) return;
      sent = true;
      await send();
    } finally {
      if (!sent && attempt.aborted && !attempt.replaced) rollback(sessionId, directory, written);
    }
  };

  const notifyGoalChanged = (sessionId: string, goal: SessionGoal | null) => {
    const resetResume = goal?.statusReason === 'resumed' && goal.turnsUsed === 0;
    const tick = activeTicks.get(sessionId);
    if (tick?.goalId && (goal?.id !== tick.goalId || resetResume)) {
      tick.replaced = true;
    } else if (tick && goal?.status === 'paused') {
      tick.aborted = true;
    }
    if (goal?.status === 'paused' && busy.has(sessionId)) stopsInFlight.add(sessionId);
    if (goal?.status === 'active' && goal.statusReason === 'resumed' && stopsInFlight.delete(sessionId)) supersededStops.add(sessionId);
    const attempt = rollbacks.get(sessionId);
    if (attempt && (goal?.id !== attempt.goalId || resetResume)) {
      cancel(rollbacks, sessionId);
    } else if (attempt && goal?.statusReason === 'resumed' && !attempt.running) {
      clearTimeout(attempt.timer);
      void attempt.run();
    }
  };

  const notifyStatus = (sessionId: string, type: string) => {
    if (type === 'busy') {
      busy.add(sessionId);
      supersededStops.delete(sessionId);
    } else if (type === 'idle') {
      busy.delete(sessionId);
      stopsInFlight.delete(sessionId);
    }
  };

  return {
    pause,
    sendReserved,
    notifyGoalChanged,
    notifyStatus,
    isSupersededStop: (sessionId: string) => supersededStops.delete(sessionId),
    cancelPause: (sessionId: string) => cancel(pauses, sessionId),
    hasPending: (sessionId: string) => pauses.has(sessionId) || rollbacks.has(sessionId),
    startTick: (sessionId: string, attempt: GoalTick) => activeTicks.set(sessionId, attempt),
    finishTick: (sessionId: string) => activeTicks.delete(sessionId),
    stop: () => {
      stopped = true;
      for (const attempts of [pauses, rollbacks]) {
        for (const sessionId of attempts.keys()) cancel(attempts, sessionId);
      }
      activeTicks.clear();
      busy.clear();
      stopsInFlight.clear();
      supersededStops.clear();
    },
  };
};
