// Deterministic resize transaction state machine.
//
// Replaces the previous fixed 340ms "settling" timer with an explicit
// idle -> dragging -> finalizing -> idle transaction. A release or cancel
// opens the finalizing phase: registered finalizers (typically the visible
// message list) run their single remeasure + anchor restore, and the
// transaction only returns to idle once every finalizer has completed — or a
// 1000ms fail-safe forces it back (recorded as an abnormal completion). This
// removes the double end notification and the ~300ms/640ms double remeasure
// that the timer-based settling window caused.
//
// Consumers that only need the old boolean semantics keep using
// `isResizeInteractionActive()` / `isResizeSettling()` / `setResizeInteractionActive`
// (derived compatibility methods); panel handles migrate to the explicit
// begin/release/cancel transaction API to obtain a transactionId.

export type ResizeInteractionSource = 'left-sidebar' | 'context-panel';

/** How the transaction started: a pointer drag or a programmatic width
 *  animation (quick open/close toggle, mode switch). */
export type ResizeOrigin = 'pointer' | 'programmatic';

export type ResizeInteractionPhase = 'idle' | 'dragging' | 'finalizing';

/** Why a transaction ended. `released` is the normal path; the rest are
 *  exceptional and are recorded for diagnostics. */
export type ResizeFinalizeReason =
  | 'released'
  | 'cancelled'
  | 'new-drag'
  | 'timeout';

export type ResizeFinalizer = (signal: AbortSignal) => void | Promise<void>;

type ResizeInteractionListener = (active: boolean) => void;

import { recordPerformanceTraceEvent } from '@/stores/utils/performanceTrace';

/** Injected clock/frame scheduler so the state machine is deterministically
 *  testable without depending on global timers or requestAnimationFrame. */
export interface ResizeScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  requestAnimationFrame(handler: () => void): unknown;
  cancelAnimationFrame(id: unknown): void;
}

const defaultScheduler: ResizeScheduler = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
  requestAnimationFrame: (handler) => window.requestAnimationFrame(handler),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id as number),
};

let scheduler: ResizeScheduler = defaultScheduler;

export const setResizeSchedulerForTests = (next: ResizeScheduler): void => {
  scheduler = next;
};

export const resetResizeSchedulerForTests = (): void => {
  scheduler = defaultScheduler;
};

/** Reset the transaction state machine to idle. Test-only: production code
 *  never calls this (a fresh transaction supersedes finalizing on its own). */
export const resetResizeInteractionForTests = (): void => {
  finalizeAbortController?.abort();
  finalizeAbortController = null;
  clearFailSafe();
  pendingFinalizers.clear();
  activeSources.clear();
  sourceTransactionIds.clear();
  currentTransaction = null;
  phase = 'idle';
};

/** Abnormal-completion budget for a finalizing phase. Finalizers are expected
 *  to finish well inside this; the timer only exists to guarantee the UI can
 *  never get stuck in finalizing after a buggy/never-resolving finalizer. */
const FAIL_SAFE_MS = 1000;

let phase: ResizeInteractionPhase = 'idle';
let nextTransactionId = 0;
let currentTransaction: number | null = null;
const activeSources = new Set<ResizeInteractionSource>();
const sourceTransactionIds = new Map<ResizeInteractionSource, number>();
let failSafeTimer: unknown = null;
let finalizeAbortController: AbortController | null = null;
const pendingFinalizers = new Set<ResizeFinalizer>();
const listeners = new Set<ResizeInteractionListener>();
let finalizingStartedAt = 0;
let finalizingSource: ResizeInteractionSource | null = null;
let finalizingReason: ResizeFinalizeReason = 'released';

const nowMs = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const notify = (): void => {
  const active = phase === 'dragging';
  for (const listener of listeners) {
    listener(active);
  }
};

const clearFailSafe = (): void => {
  if (failSafeTimer !== null) {
    scheduler.clearTimeout(failSafeTimer);
    failSafeTimer = null;
  }
};

const startFailSafe = (transactionId: number): void => {
  clearFailSafe();
  failSafeTimer = scheduler.setTimeout(() => {
    failSafeTimer = null;
    completeFinalization(transactionId, 'timeout');
  }, FAIL_SAFE_MS);
};

const completeFinalization = (
  transactionId: number,
  reason: ResizeFinalizeReason,
): void => {
  if (currentTransaction !== transactionId || phase !== 'finalizing') {
    return;
  }
  // Record the transaction outcome BEFORE clearing state so source/phase are
  // still readable. This is how the perf tooling learns about cancel vs
  // released vs timeout endings.
  if (typeof window !== 'undefined') {
    recordPerformanceTraceEvent(
      'ui.resize.transaction_end',
      {
        transactionId,
        source: finalizingSource ?? 'unknown',
        phase: 'finalizing',
        reason: reason === 'timeout' ? 'timeout' : finalizingReason,
        durationMs: Math.round(nowMs() - finalizingStartedAt),
      },
      0,
      undefined,
    );
  }
  clearFailSafe();
  finalizeAbortController?.abort();
  finalizeAbortController = null;
  pendingFinalizers.clear();
  activeSources.clear();
  sourceTransactionIds.clear();
  finalizingSource = null;
  finalizingReason = 'released';
  currentTransaction = null;
  phase = 'idle';
  notify();
};

const enterFinalizing = (
  transactionId: number,
  source: ResizeInteractionSource,
  reason: Exclude<ResizeFinalizeReason, 'timeout' | 'new-drag'> = 'released',
): void => {
  phase = 'finalizing';
  finalizingStartedAt = nowMs();
  finalizingSource = source;
  finalizingReason = reason;
  startFailSafe(transactionId);
  notify();

  const finalizers = [...pendingFinalizers];
  pendingFinalizers.clear();
  if (finalizers.length === 0) {
    // No visible list to remeasure: end on the next frame so the final
    // width commit frame is not cut short by an immediate reset.
    scheduler.requestAnimationFrame(() => {
      completeFinalization(transactionId, 'released');
    });
    return;
  }

  const controller = new AbortController();
  finalizeAbortController = controller;
  let settled = false;
  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    completeFinalization(transactionId, 'released');
  };
  Promise.all(
    finalizers.map((fn) => Promise.resolve().then(() => fn(controller.signal))),
  ).then(finish, finish);
};

/**
 * Start a resize transaction. Returns the transaction id that must be passed
 * to `releaseResizeInteraction` / `cancelResizeInteraction`.
 *
 * ONE GLOBAL TRANSACTION per active period: a second source joining while a
 * transaction is already dragging REUSES the current id (it only registers its
 * own source accounting) — no re-capture, no finalizer reset. Only a transition
 * out of idle/finalizing creates a fresh id and fires the synchronous
 * transaction-start participants (the anchor controller captures the OLD
 * layout there, before the first width write).
 *
 * Starting a new transaction while a previous one is still finalizing aborts
 * the old finalization (finalizers observe the abort signal) and supersedes
 * it; a stale completion from the old transaction is then a no-op because the
 * transaction id no longer matches.
 */
export const beginResizeInteraction = (
  source: ResizeInteractionSource,
  origin: ResizeOrigin = 'pointer',
): number => {
  if (phase === 'finalizing') {
    finalizeAbortController?.abort();
    finalizeAbortController = null;
    clearFailSafe();
  }
  if (phase === 'dragging' && currentTransaction !== null) {
    // Second source joins the SAME active period: share the id.
    activeSources.add(source);
    sourceTransactionIds.set(source, currentTransaction);
    return currentTransaction;
  }
  const transactionId = ++nextTransactionId;
  pendingFinalizers.clear();
  activeSources.add(source);
  sourceTransactionIds.set(source, transactionId);
  currentTransaction = transactionId;
  phase = 'dragging';
  // Synchronous transaction-start: participants capture the pre-resize layout
  // BEFORE any width frame may be written.
  notifyTransactionStart({ transactionId, source, origin });
  notify();
  return transactionId;
};

/**
 * End a drag normally (pointerup). If other sources are still dragging, the
 * transaction stays open; otherwise the finalizing phase starts and the
 * transaction completes once every registered finalizer has run.
 */
export const releaseResizeInteraction = (
  source: ResizeInteractionSource,
  transactionId: number,
): void => {
  if (sourceTransactionIds.get(source) !== transactionId || !activeSources.has(source)) {
    return;
  }
  activeSources.delete(source);
  sourceTransactionIds.delete(source);
  if (activeSources.size > 0) {
    return;
  }
  enterFinalizing(transactionId, source);
};

/**
 * End a drag abnormally (pointercancel, lost capture, window blur,
 * visibilitychange). The last legal width has already been committed by the
 * caller, so the same single finalization path runs; the reason is preserved
 * for diagnostics.
 */
export const cancelResizeInteraction = (
  source: ResizeInteractionSource,
  transactionId: number,
  reason: Exclude<ResizeFinalizeReason, 'timeout' | 'new-drag'> = 'cancelled',
): void => {
  if (sourceTransactionIds.get(source) !== transactionId || !activeSources.has(source)) {
    return;
  }
  activeSources.delete(source);
  sourceTransactionIds.delete(source);
  if (activeSources.size > 0) {
    return;
  }
  enterFinalizing(transactionId, source, reason);
};

/**
 * Register a finalizer that runs once at the end of the current drag
 * transaction (during the finalizing phase). It receives an AbortSignal that
 * fires if a new transaction starts before it completes. The transaction stays
 * in `finalizing` until every registered finalizer has resolved.
 *
 * Registration only takes effect for the transaction that is active at
 * registration time (begin clears the set); the returned unsubscribe removes
 * the finalizer if the registration happens to be superseded.
 */
export const registerResizeFinalizer = (
  finalizer: ResizeFinalizer,
): (() => void) => {
  pendingFinalizers.add(finalizer);
  return () => {
    pendingFinalizers.delete(finalizer);
  };
};

/** True while at least one panel drag is actively moving the pointer. */
export const isResizeInteractionActive = (): boolean => phase === 'dragging';

/** True while dragging OR while the post-release remeasure/anchor restore is
 *  still running. Consumers (virtual list measurement freeze, scroll
 *  compensation) must keep behaving as "mid-resize" throughout this window. */
export const isResizeSettling = (): boolean => phase !== 'idle';

/** Stable boolean snapshot for `useSyncExternalStore`. */
export const getResizeSettlingSnapshot = (): boolean => isResizeSettling();

/** Alias with the same semantics; use when the caller wants the transaction
 *  framing rather than the settling-window framing. */
export const getResizeInteractionSnapshot = (): boolean => isResizeSettling();

export const getResizeInteractionPhase = (): ResizeInteractionPhase => phase;

/** The active transaction id (null when idle). Frame participants use it to
 *  ignore frames from superseded transactions. */
export const getCurrentResizeTransactionId = (): number | null => currentTransaction;

export const subscribeResizeInteraction = (
  listener: ResizeInteractionListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Per-frame resize participants. A panel drag applies its width once per
 * animation frame (usePanelResize's single-flight rAF); every registered
 * participant is invoked IN THAT SAME FRAME, immediately after the width is
 * written and before the browser paints. This is how the chat anchor
 * controller adjusts scrollTop with the width — one deterministic writer per
 * frame, no post-paint chase. Participants are invoked for every live width
 * frame AND for the final width commit (release/cancel), so the last frame
 * cannot be missed.
 */
/** Per-frame participant payload. `frameSequence` is a monotonic sequence
 *  (across transactions) so consumers can detect "a new frame happened" for
 *  the current transaction without deduping by width (two panels can share a
 *  width value and would otherwise lose frames). */
export type ResizeFrameParticipant = (frame: {
    transactionId: number;
    width: number;
    kind: 'drag' | 'final' | 'cancel';
    origin: ResizeOrigin;
    source: ResizeInteractionSource;
    frameSequence: number;
}) => void;

const frameParticipants = new Set<ResizeFrameParticipant>();

/** Monotonic frame sequence — never dedupe by width. */
let frameSequence = 0;

/**
 * Synchronous transaction-start participants. Fired from beginResizeInteraction
 * for a FRESH transaction (idle/finalizing -> dragging), BEFORE the first width
 * frame may be written. The anchor controller captures the pre-resize layout
 * here, so a quick programmatic toggle's first animated width lands on an
 * already-anchored baseline. Joining sources within the same active period do
 * NOT re-fire (no re-capture, no finalizer reset).
 */
export type ResizeTransactionStartParticipant = (start: {
    transactionId: number;
    source: ResizeInteractionSource;
    origin: ResizeOrigin;
}) => void;

const transactionStartParticipants = new Set<ResizeTransactionStartParticipant>();

/** Register a synchronous transaction-start participant; returns the
 *  unsubscribe. */
export const registerResizeTransactionStartParticipant = (
    participant: ResizeTransactionStartParticipant,
): (() => void) => {
    transactionStartParticipants.add(participant);
    return () => {
        transactionStartParticipants.delete(participant);
    };
};

const notifyTransactionStart = (start: {
    transactionId: number;
    source: ResizeInteractionSource;
    origin: ResizeOrigin;
}): void => {
    for (const participant of transactionStartParticipants) {
        participant(start);
    }
};

/** Register a per-frame participant; returns the unsubscribe. */
export const registerResizeFrameParticipant = (
    participant: ResizeFrameParticipant,
): (() => void) => {
    frameParticipants.add(participant);
    return () => {
        frameParticipants.delete(participant);
    };
};

/** Notify participants that the panel width was applied this frame. Called by
 *  usePanelResize from inside its rAF (and from the final width commit). */
export const notifyResizeFrame = (frame: {
    transactionId: number;
    width: number;
    kind: 'drag' | 'final' | 'cancel';
    origin: ResizeOrigin;
    source: ResizeInteractionSource;
}): void => {
    const seq = ++frameSequence;
    if (frameParticipants.size === 0) {
        return;
    }
    for (const participant of frameParticipants) {
        participant({ ...frame, frameSequence: seq });
    }
};

/** Test-only: clear registered participants. */
export const resetResizeFrameParticipantsForTests = (): void => {
    frameParticipants.clear();
    transactionStartParticipants.clear();
    frameSequence = 0;
};

/**
 * Legacy two-arg wrapper kept for callers that have not yet migrated to the
 * explicit transaction API: `active=true` maps to begin, `active=false` maps
 * to release using the tracked transaction id for that source.
 */
export const setResizeInteractionActive = (
  source: ResizeInteractionSource,
  active: boolean,
): void => {
  if (active) {
    beginResizeInteraction(source);
    return;
  }
  const transactionId = sourceTransactionIds.get(source);
  if (transactionId !== undefined) {
    releaseResizeInteraction(source, transactionId);
  }
};
