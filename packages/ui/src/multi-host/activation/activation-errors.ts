/**
 * Structured activation error construction.
 *
 * Errors are safe for logging: no secrets, tokens, descriptors, or
 * connection URLs appear in messages or metadata.
 */

import type { HostId } from '../types';
import type { ActivationError, ActivationErrorCode, ActivationStage } from './types';

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  'token',
  'clienttoken',
  'authorization',
  'relaygrant',
  'pairingsecret',
  'privatekey',
  'apiurl',
  'sshendpoint',
  'relayserverid',
  'requestheaders',
]);

/**
 * Redact sensitive fields from an object for safe logging.
 * Returns a new object with sensitive values replaced by '[REDACTED]'.
 */
export const redactMeta = (meta: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 100) {
      out[k] = v.slice(0, 20) + '...[truncated]';
    } else {
      out[k] = v;
    }
  }
  return out;
};

/**
 * Create a safe label for a host descriptor that never leaks transport details.
 */
export const safeHostLabel = (hostId: HostId): string => `host:${hostId}`;

// ---------------------------------------------------------------------------
// Error factory
// ---------------------------------------------------------------------------

export const createActivationError = (
  code: ActivationErrorCode,
  stage: ActivationStage,
  message: string,
  options?: {
    hostId?: HostId;
    requestId?: string;
    cause?: unknown;
  },
): ActivationError => ({
  code,
  stage,
  message,
  hostId: options?.hostId,
  requestId: options?.requestId,
  cause: options?.cause,
});

// ---------------------------------------------------------------------------
// Well-known error factories
// ---------------------------------------------------------------------------

export const hostNotFound = (
  hostId: HostId,
  requestId?: string,
): ActivationError =>
  createActivationError('HOST_NOT_FOUND', 'idle', `Host ${hostId} not found`, {
    hostId,
    requestId,
  });

export const hostOffline = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError('HOST_OFFLINE', 'validating', `Host ${hostId} is offline`, {
    hostId,
    requestId,
    cause,
  });

export const unsupportedTransport = (
  hostId: HostId,
  requestId?: string,
): ActivationError =>
  createActivationError(
    'UNSUPPORTED_TRANSPORT',
    'validating',
    `Transport for host ${hostId} is not supported`,
    { hostId, requestId },
  );

export const authenticationFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'AUTHENTICATION_FAILED',
    'validating',
    `Authentication failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const validationFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'VALIDATION_FAILED',
    'validating',
    `Validation failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const switchFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'SWITCH_FAILED',
    'switching-host',
    `Host switch failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const runtimeReadyTimeout = (
  hostId: HostId,
  requestId?: string,
): ActivationError =>
  createActivationError(
    'RUNTIME_READY_TIMEOUT',
    'waiting-runtime',
    `Runtime ready timeout for host ${hostId}`,
    { hostId, requestId },
  );

export const projectNotFound = (
  hostId: HostId,
  requestId?: string,
): ActivationError =>
  createActivationError(
    'PROJECT_NOT_FOUND',
    'opening-project',
    `Project not found on host ${hostId}`,
    { hostId, requestId },
  );

export const directoryNotFound = (
  hostId: HostId,
  requestId?: string,
): ActivationError =>
  createActivationError(
    'DIRECTORY_NOT_FOUND',
    'opening-project',
    `Directory not found on host ${hostId}`,
    { hostId, requestId },
  );

export const sessionNotFound = (
  hostId: HostId,
  sessionId: string,
  requestId?: string,
): ActivationError =>
  createActivationError(
    'SESSION_NOT_FOUND',
    'verifying-session',
    `Session ${sessionId} not found on host ${hostId}`,
    { hostId, requestId },
  );

export const navigationFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'NAVIGATION_FAILED',
    'opening-project',
    `Navigation failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const selectionFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'SELECTION_FAILED',
    'selecting-session',
    `Session selection failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const cancelled = (
  requestId?: string,
): ActivationError =>
  createActivationError('CANCELLED', 'idle', 'Activation cancelled', {
    requestId,
  });

export const controllerDisposed = (
  requestId?: string,
): ActivationError =>
  createActivationError('CONTROLLER_DISPOSED', 'idle', 'Controller disposed', {
    requestId,
  });

export const rollbackFailed = (
  hostId: HostId,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError(
    'ROLLBACK_FAILED',
    'rolling-back',
    `Rollback failed for host ${hostId}`,
    { hostId, requestId, cause },
  );

export const unknownError = (
  stage: ActivationStage,
  requestId?: string,
  cause?: unknown,
): ActivationError =>
  createActivationError('UNKNOWN', stage, 'Unknown activation error', {
    requestId,
    cause,
  });
