/**
 * Internal activation state management.
 *
 * Tracks the current activation request, AbortController, stage,
 * and notifies listeners on state changes. Not exported publicly —
 * only used by the controller and transaction internals.
 */

import type { HostSessionRef } from '../types';
import type { ActivationError, ActivationStage, ActivationState } from './types';

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

export interface ActivationInternalState {
  /** Monotonically increasing request counter. */
  requestCounter: number;
  /** Current request id (string of the counter). */
  currentRequestId: string | null;
  /** AbortController for the current activation. */
  abortController: AbortController | null;
  /** Target session ref for the current activation. */
  targetRef: HostSessionRef | null;
  /** Timestamp when the current activation started. */
  startedAt: number | null;
  /** Current stage. */
  stage: ActivationStage;
  /** Error from the current or last activation (cleared on new activation). */
  error: ActivationError | null;
  /** Listeners subscribed to state changes. */
  listeners: Set<(state: ActivationState) => void>;
  /** Whether the controller has been disposed. */
  disposed: boolean;
  /** Pending timeout timers (keyed by stage). */
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createActivationInternalState = (): ActivationInternalState => ({
  requestCounter: 0,
  currentRequestId: null,
  abortController: null,
  targetRef: null,
  startedAt: null,
  stage: 'idle',
  error: null,
  listeners: new Set(),
  disposed: false,
  pendingTimers: new Set(),
});

// ---------------------------------------------------------------------------
// Snapshot helpers (read-only view for external consumers)
// ---------------------------------------------------------------------------

export const toPublicState = (s: ActivationInternalState): ActivationState => ({
  stage: s.stage,
  requestId: s.currentRequestId,
  targetRef: s.targetRef,
  startedAt: s.startedAt,
  error: s.error,
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export const advanceStage = (
  s: ActivationInternalState,
  stage: ActivationStage,
): void => {
  s.stage = stage;
  notifyListeners(s);
};

export const setError = (
  s: ActivationInternalState,
  error: ActivationError,
): void => {
  s.error = error;
  s.stage = 'failed';
  notifyListeners(s);
};

export const clearError = (s: ActivationInternalState): void => {
  if (s.error) {
    s.error = null;
  }
};

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new activation request. Returns the new requestId.
 * Aborts any previous activation.
 */
export const startNewRequest = (
  s: ActivationInternalState,
  targetRef: HostSessionRef,
): { requestId: string; abortController: AbortController } => {
  // Abort previous
  if (s.abortController) {
    s.abortController.abort();
  }
  clearPendingTimers(s);

  s.requestCounter++;
  const requestId = String(s.requestCounter);
  const abortController = new AbortController();

  s.currentRequestId = requestId;
  s.abortController = abortController;
  s.targetRef = targetRef;
  s.startedAt = Date.now();
  s.stage = 'idle';
  s.error = null;

  notifyListeners(s);
  return { requestId, abortController };
};

/**
 * Check if the given requestId is still the current one.
 */
export const isCurrentRequest = (
  s: ActivationInternalState,
  requestId: string,
): boolean => s.currentRequestId === requestId;

/**
 * Check if the current activation has been aborted.
 */
export const isAborted = (s: ActivationInternalState): boolean =>
  s.abortController?.signal.aborted === true;

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

export const scheduleTimer = (
  s: ActivationInternalState,
  ms: number,
  callback: () => void,
): void => {
  const timer = setTimeout(() => {
    s.pendingTimers.delete(timer);
    callback();
  }, ms);
  s.pendingTimers.add(timer);
};

export const clearPendingTimers = (s: ActivationInternalState): void => {
  for (const timer of s.pendingTimers) {
    clearTimeout(timer);
  }
  s.pendingTimers.clear();
};

// ---------------------------------------------------------------------------
// Listener management
// ---------------------------------------------------------------------------

export const subscribeListener = (
  s: ActivationInternalState,
  listener: (state: ActivationState) => void,
): (() => void) => {
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
  };
};

const notifyListeners = (s: ActivationInternalState): void => {
  const publicState = toPublicState(s);
  for (const listener of s.listeners) {
    listener(publicState);
  }
};

// ---------------------------------------------------------------------------
// Reset to idle
// ---------------------------------------------------------------------------

export const resetToIdle = (s: ActivationInternalState): void => {
  s.currentRequestId = null;
  s.abortController = null;
  s.targetRef = null;
  s.startedAt = null;
  s.stage = 'idle';
  s.error = null;
  clearPendingTimers(s);
  notifyListeners(s);
};

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

export const disposeState = (s: ActivationInternalState): void => {
  if (s.abortController) {
    s.abortController.abort();
  }
  clearPendingTimers(s);
  s.disposed = true;
  s.currentRequestId = null;
  s.abortController = null;
  s.targetRef = null;
  s.startedAt = null;
  s.stage = 'idle';
  s.error = null;
  s.listeners.clear();
};
