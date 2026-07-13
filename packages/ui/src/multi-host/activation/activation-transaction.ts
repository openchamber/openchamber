/**
 * Activation transaction — the core state machine.
 *
 * Orchestrates: validate → switch host → wait ready → open project →
 * verify session → select session → clear unread.
 *
 * Handles: concurrency (abort old), rollback, timeout, cancellation.
 */

import type { HostDescriptor, HostId, HostSessionRef } from '../types';
import type {
  ActivationError,
  ActivationResult,
  ActivationStage,
  RuntimeActivationAdapter,
  RuntimeSnapshot,
  SafeActivationLogger,
} from './types';
import type { ActivationInternalState } from './activation-state';
import {
  advanceStage,
  isAborted,
  isCurrentRequest,
  setError,
  startNewRequest,
} from './activation-state';
import {
  authenticationFailed,
  cancelled,
  controllerDisposed,
  directoryNotFound,
  hostNotFound,
  hostOffline,
  navigationFailed,
  projectNotFound,
  rollbackFailed,
  runtimeReadyTimeout,
  selectionFailed,
  sessionNotFound,
  switchFailed,
  unknownError,
  unsupportedTransport,
} from './activation-errors';

// ---------------------------------------------------------------------------
// Timeout constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

export interface TransactionContext {
  state: ActivationInternalState;
  adapter: RuntimeActivationAdapter;
  getHost: (hostId: HostId) => HostDescriptor | undefined;
  clearUnread: (ref: HostSessionRef) => void;
  timeoutMs: number;
  rollbackTimeoutMs: number;
  logger: SafeActivationLogger;
}

/**
 * Execute a full activation transaction for the given session ref.
 *
 * Returns an ActivationResult. Never throws — all errors are caught
 * and returned as structured ActivationResult with kind 'failure'.
 */
export const runActivationTransaction = async (
  ctx: TransactionContext,
  ref: HostSessionRef,
): Promise<ActivationResult> => {
  const { state, adapter, getHost, clearUnread, timeoutMs, logger } = ctx;

  // Reject if disposed
  if (state.disposed) {
    const err = controllerDisposed();
    return { kind: 'failure', requestId: '', error: err };
  }

  // Start new request (aborts any previous)
  const { requestId, abortController } = startNewRequest(state, ref);
  const { signal } = abortController;

  logger.info('idle', 'Activation started', {
    requestId,
    hostId: ref.hostId,
    sessionId: ref.sessionId,
  });

  // ---- Stage 1: Resolve host descriptor ----
  const host = getHost(ref.hostId);
  if (!host) {
    const err = hostNotFound(ref.hostId, requestId);
    setError(state, err);
    logger.error('idle', 'Host not found', { requestId, hostId: ref.hostId });
    return { kind: 'failure', requestId, error: err };
  }

  // ---- Stage 2: Check if already active session ----
  if (adapter.isCurrentSession(ref)) {
    advanceStage(state, 'succeeded');
    logger.info('succeeded', 'Session already active (no-op)', {
      requestId,
      hostId: ref.hostId,
      sessionId: ref.sessionId,
    });
    return { kind: 'no-op', requestId };
  }

  // Guard: already aborted by a newer activation?
  if (signal.aborted) {
    const err = cancelled(requestId);
    return { kind: 'cancelled', requestId, error: err };
  }

  // ---- Stage 3: Save snapshot for potential rollback ----
  const previousSnapshot = adapter.getCurrentSnapshot();

  // Track whether we actually switched host (for rollback decisions)
  let hostSwitched = false;

  // ---- Stage 4: Validate host ----
  const snapshot = await runStage(ctx, {
    stage: 'validating',
    requestId,
    signal,
    host,
    snapshot: previousSnapshot,
    action: async (stageSignal) => {
      await withTimeout(adapter.validateHost(host, stageSignal), timeoutMs, stageSignal);
    },
    onError: (rawErr, stage) => {
      const msg = rawErr instanceof Error ? rawErr.message : '';
      if (msg.includes('AUTHENTICATION_FAILED')) return authenticationFailed(ref.hostId, requestId, rawErr);
      if (msg.includes('UNSUPPORTED_TRANSPORT')) return unsupportedTransport(ref.hostId, requestId);
      if (msg.includes('HOST_OFFLINE')) return hostOffline(ref.hostId, requestId, rawErr);
      if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
      return unknownError(stage, requestId, rawErr);
    },
  });
  if (snapshot.kind === 'result') return snapshot.result;

  // ---- Stage 5: Switch host (if needed) ----
  if (!adapter.isCurrentHost(ref.hostId)) {
    const switchResult = await runStage(ctx, {
      stage: 'switching-host',
      requestId,
      signal,
      host,
      snapshot: previousSnapshot,
      action: async (stageSignal) => {
        await withTimeout(adapter.switchHost(host, stageSignal), timeoutMs, stageSignal);
        hostSwitched = true;
      },
      onError: (rawErr) => {
        const msg = rawErr instanceof Error ? rawErr.message : '';
        if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
        return switchFailed(ref.hostId, requestId, rawErr);
      },
    });
    if (switchResult.kind === 'result') return switchResult.result;
  }

  // ---- Stage 6: Wait for runtime ready ----
  const readyResult = await runStage(ctx, {
    stage: 'waiting-runtime',
    requestId,
    signal,
    host,
    snapshot: previousSnapshot,
    action: async (stageSignal) => {
      await withTimeout(adapter.waitForRuntimeReady(host, stageSignal), timeoutMs, stageSignal);
    },
    onError: (rawErr, stage) => {
      const msg = rawErr instanceof Error ? rawErr.message : '';
      if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
      return unknownError(stage, requestId, rawErr);
    },
  });
  if (readyResult.kind === 'result') return readyResult.result;

  // ---- Stage 7: Open project/directory ----
  const projectResult = await runStage(ctx, {
    stage: 'opening-project',
    requestId,
    signal,
    host,
    snapshot: previousSnapshot,
    action: async (stageSignal) => {
      await withTimeout(adapter.openProjectOrDirectory(ref, stageSignal), timeoutMs, stageSignal);
    },
    onError: (rawErr) => {
      const msg = rawErr instanceof Error ? rawErr.message : '';
      if (msg.includes('PROJECT_NOT_FOUND')) return projectNotFound(ref.hostId, requestId);
      if (msg.includes('DIRECTORY_NOT_FOUND')) return directoryNotFound(ref.hostId, requestId);
      if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
      return navigationFailed(ref.hostId, requestId, rawErr);
    },
    shouldRollback: () => hostSwitched,
  });
  if (projectResult.kind === 'result') return projectResult.result;

  // ---- Stage 8: Verify session exists ----
  const verifyResult = await runStage(ctx, {
    stage: 'verifying-session',
    requestId,
    signal,
    host,
    snapshot: previousSnapshot,
    action: async (stageSignal) => {
      const exists = await withTimeout(
        adapter.verifySessionExists(ref, stageSignal),
        timeoutMs,
        stageSignal,
      );
      if (!exists) {
        throw sessionNotFound(ref.hostId, ref.sessionId, requestId);
      }
    },
    onError: (rawErr, stage) => {
      if (isActivationError(rawErr) && rawErr.code === 'SESSION_NOT_FOUND') {
        return sessionNotFound(ref.hostId, ref.sessionId, requestId);
      }
      const msg = rawErr instanceof Error ? rawErr.message : '';
      if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
      return unknownError(stage, requestId, rawErr);
    },
    shouldRollback: () => hostSwitched,
  });
  if (verifyResult.kind === 'result') return verifyResult.result;

  // ---- Stage 9: Select session ----
  const selectResult = await runStage(ctx, {
    stage: 'selecting-session',
    requestId,
    signal,
    host,
    snapshot: previousSnapshot,
    action: async (stageSignal) => {
      await withTimeout(adapter.selectSession(ref, stageSignal), timeoutMs, stageSignal);
    },
    onError: (rawErr) => {
      const msg = rawErr instanceof Error ? rawErr.message : '';
      if (msg.includes('TIMEOUT')) return runtimeReadyTimeout(ref.hostId, requestId);
      return selectionFailed(ref.hostId, requestId, rawErr);
    },
  });
  if (selectResult.kind === 'result') return selectResult.result;

  // ---- Stage 10: Check still current (post-async boundary) ----
  if (!isCurrentRequest(state, requestId) || isAborted(state)) {
    const err = cancelled(requestId);
    setError(state, err);
    return { kind: 'cancelled', requestId, error: err };
  }

  // ---- Stage 11: Clear unread (only for the target) ----
  clearUnread(ref);
  logger.info('succeeded', 'Unread cleared', {
    requestId,
    hostId: ref.hostId,
    sessionId: ref.sessionId,
  });

  // ---- Done ----
  advanceStage(state, 'succeeded');
  logger.info('succeeded', 'Activation completed', {
    requestId,
    hostId: ref.hostId,
  });

  return { kind: 'success', requestId };
};

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Attempt to restore the previous runtime snapshot after a failure.
 * Uses a dedicated AbortController for rollback, independent of the
 * activation's signal.
 */
export const runRollback = async (
  adapter: RuntimeActivationAdapter,
  previousSnapshot: RuntimeSnapshot,
  rollbackTimeoutMs: number,
  logger: SafeActivationLogger,
): Promise<ActivationError | null> => {
  const rollbackController = new AbortController();
  const rollbackTimeout = setTimeout(() => rollbackController.abort(), rollbackTimeoutMs);

  try {
    await adapter.restore(previousSnapshot, rollbackController.signal);
    logger.info('rolling-back', 'Rollback succeeded');
    return null;
  } catch (err) {
    logger.error('rolling-back', 'Rollback failed', { cause: err });
    return rollbackFailed('' as HostId, undefined, err);
  } finally {
    clearTimeout(rollbackTimeout);
  }
};

// ---------------------------------------------------------------------------
// Stage runner with timeout, abort, and rollback
// ---------------------------------------------------------------------------

interface StageConfig {
  stage: ActivationStage;
  requestId: string;
  signal: AbortSignal;
  host: HostDescriptor;
  snapshot: RuntimeSnapshot;
  action: (signal: AbortSignal) => Promise<void>;
  onError: (err: unknown, stage: ActivationStage) => ActivationError;
  /** Override rollback decision. Defaults to: host switched and not in validating/switching stage. */
  shouldRollback?: () => boolean;
}

type StageOutcome =
  | { kind: 'result'; result: ActivationResult }
  | { kind: 'continue' };

const runStage = async (
  ctx: TransactionContext,
  config: StageConfig,
): Promise<StageOutcome> => {
  const { state, adapter, logger } = ctx;
  const { stage, requestId, signal, host, snapshot, action, onError, shouldRollback } = config;

  // Guard: still current?
  if (!isCurrentRequest(state, requestId) || signal.aborted) {
    return {
      kind: 'result',
      result: { kind: 'cancelled', requestId, error: { code: 'CANCELLED', stage, message: 'Cancelled' } },
    };
  }

  advanceStage(state, stage);
  logger.debug(stage, `Stage started`, { requestId, hostId: host.hostId });

  try {
    await action(signal);
  } catch (err) {
    // Check if this is an abort (from a newer activation taking over)
    if (signal.aborted || !isCurrentRequest(state, requestId)) {
      return {
        kind: 'result',
        result: { kind: 'cancelled', requestId, error: { code: 'CANCELLED', stage, message: 'Cancelled' } },
      };
    }

    // Map raw error to ActivationError
    const activationErr = onError(err, stage);

    logger.error(stage, `Stage failed: ${activationErr.code}`, {
      requestId,
      hostId: host.hostId,
    });

    // Determine if rollback is needed
    const doRollback = shouldRollback ? shouldRollback() : false;

    if (doRollback) {
      advanceStage(state, 'rolling-back');
      const rollbackErr = await runRollback(adapter, snapshot, ctx.rollbackTimeoutMs, logger);
      setError(state, activationErr);
      return {
        kind: 'result',
        result: {
          kind: 'failure',
          requestId,
          error: activationErr,
          rollbackError: rollbackErr ?? undefined,
        },
      };
    }

    setError(state, activationErr);
    return {
      kind: 'result',
      result: { kind: 'failure', requestId, error: activationErr },
    };
  }

  return { kind: 'continue' };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('TIMEOUT'));
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('ABORTED'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (val) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
};

const isActivationError = (err: unknown): err is ActivationError =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  'stage' in err &&
  'message' in err;
