/**
 * Exponential backoff reconnect policy with jitter.
 *
 * Matches the pacing strategy from the main event-pipeline:
 * - base 250ms, exponential growth, max exponent 8
 * - visible+online: cap 5s
 * - hidden/offline: cap 60s
 * - permanent 4xx (except 408/429): jump to long cap
 * - jitter added to avoid thundering herd across hosts
 */

import type { ReconnectPolicy, ReconnectAttempt } from './types';

const BASE_MS = 250;
const CAP_VISIBLE_MS = 5_000;
const CAP_HIDDEN_OR_OFFLINE_MS = 60_000;
const MAX_EXPONENT = 8;
const AUTH_FAILURE_CAP_MS = 60_000;

const isOffline = (): boolean =>
  typeof navigator === 'object' && navigator !== null && navigator.onLine === false;

const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState !== 'visible';

/**
 * Compute jitter in [0, half of base delay) to spread reconnect attempts
 * across multiple hosts that disconnect simultaneously.
 */
const jitter = (baseMs: number): number =>
  Math.floor(Math.random() * Math.min(baseMs / 2, 1000));

export function createReconnectPolicy(): ReconnectPolicy {
  const nextDelay = (attemptNumber: number, isPermanentError: boolean): ReconnectAttempt => {
    const failures = Math.max(1, attemptNumber);

    if (isPermanentError) {
      return {
        delayMs: AUTH_FAILURE_CAP_MS + jitter(AUTH_FAILURE_CAP_MS),
        reason: 'permanent_error',
      };
    }

    if (isOffline()) {
      return {
        delayMs: CAP_HIDDEN_OR_OFFLINE_MS,
        reason: 'offline',
      };
    }

    const cap = isHidden() ? CAP_HIDDEN_OR_OFFLINE_MS : CAP_VISIBLE_MS;
    const exponent = Math.min(failures - 1, MAX_EXPONENT);
    const base = Math.min(cap, BASE_MS * 2 ** exponent);
    const delay = base + jitter(base);

    return {
      delayMs: delay,
      reason: `attempt_${failures}`,
    };
  };

  const reset = () => {
    // No-op: backoff is purely computed from attemptNumber
  };

  return { nextDelay, reset };
}
