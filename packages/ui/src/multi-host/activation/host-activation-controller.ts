/**
 * Host activation controller — the public API.
 *
 * Non-React code can use this directly. UI subscribes via subscribe().
 * The controller never imports runtime-switch, relay, or session-ui.
 */

import type { HostSessionRef } from '../types';
import type {
  ActivationResult,
  ActivationState,
  HostActivationController,
  HostActivationControllerOptions,
  SafeActivationLogger,
} from './types';
import type { ActivationInternalState } from './activation-state';
import {
  createActivationInternalState,
  disposeState,
  subscribeListener,
  toPublicState,
  clearPendingTimers,
  resetToIdle,
  advanceStage,
} from './activation-state';
import { runActivationTransaction } from './activation-transaction';
import { controllerDisposed } from './activation-errors';
import { noopLogger } from './safe-activation-logger';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createHostActivationController = (
  options: HostActivationControllerOptions,
): HostActivationController => {
  const {
    adapter,
    getHost,
    clearUnread,
    timeoutMs = 30_000,
    rollbackTimeoutMs = 10_000,
    logger: injectedLogger,
  } = options;

  const logger: SafeActivationLogger = injectedLogger ?? noopLogger;
  const state: ActivationInternalState = createActivationInternalState();

  // --------------------------------------------------
  // Public API
  // --------------------------------------------------

  const activateSession = async (ref: HostSessionRef): Promise<ActivationResult> => {
    if (state.disposed) {
      const err = controllerDisposed();
      return { kind: 'failure', requestId: '', error: err };
    }

    return runActivationTransaction(
      { state, adapter, getHost, clearUnread, timeoutMs, rollbackTimeoutMs, logger },
      ref,
    );
  };

  const cancelCurrent = (reason?: string): void => {
    if (state.disposed) return;

    if (state.abortController) {
      state.abortController.abort();
    }
    clearPendingTimers(state);

    if (state.currentRequestId) {
      advanceStage(state, 'cancelled');
      logger.info('cancelled', 'Activation cancelled', {
        requestId: state.currentRequestId,
        reason,
      });
    }

    resetToIdle(state);
  };

  const getState = (): ActivationState => toPublicState(state);

  const subscribe = (listener: (state: ActivationState) => void): (() => void) => {
    return subscribeListener(state, listener);
  };

  const dispose = (): void => {
    disposeState(state);
    logger.info('idle', 'Controller disposed');
  };

  return {
    activateSession,
    cancelCurrent,
    getState,
    subscribe,
    dispose,
  };
};
