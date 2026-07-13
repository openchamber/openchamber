/**
 * Activation module public types.
 *
 * All activation-specific types live here. The controller never imports
 * runtime-switch, relay, or session-ui internals directly.
 */

import type { HostDescriptor, HostId, HostSessionRef } from '../types';

// ---------------------------------------------------------------------------
// Activation stages (state machine phases)
// ---------------------------------------------------------------------------

export type ActivationStage =
  | 'idle'
  | 'validating'
  | 'switching-host'
  | 'waiting-runtime'
  | 'opening-project'
  | 'verifying-session'
  | 'selecting-session'
  | 'rolling-back'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Activation error codes
// ---------------------------------------------------------------------------

export type ActivationErrorCode =
  | 'HOST_NOT_FOUND'
  | 'HOST_OFFLINE'
  | 'UNSUPPORTED_TRANSPORT'
  | 'AUTHENTICATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'SWITCH_FAILED'
  | 'RUNTIME_READY_TIMEOUT'
  | 'PROJECT_NOT_FOUND'
  | 'DIRECTORY_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'NAVIGATION_FAILED'
  | 'SELECTION_FAILED'
  | 'CANCELLED'
  | 'CONTROLLER_DISPOSED'
  | 'ROLLBACK_FAILED'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Runtime snapshot (for rollback)
// ---------------------------------------------------------------------------

export interface RuntimeSnapshot {
  hostId?: HostId;
  runtimeKey?: string;
  projectId?: string;
  directory?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Runtime activation adapter (dependency-injected bridge)
// ---------------------------------------------------------------------------

export interface RuntimeActivationAdapter {
  getCurrentSnapshot(): RuntimeSnapshot;

  isCurrentHost(hostId: HostId): boolean;

  isCurrentSession(ref: HostSessionRef): boolean;

  validateHost(host: HostDescriptor, signal: AbortSignal): Promise<void>;

  switchHost(host: HostDescriptor, signal: AbortSignal): Promise<void>;

  waitForRuntimeReady(host: HostDescriptor, signal: AbortSignal): Promise<void>;

  openProjectOrDirectory(ref: HostSessionRef, signal: AbortSignal): Promise<void>;

  verifySessionExists(ref: HostSessionRef, signal: AbortSignal): Promise<boolean>;

  selectSession(ref: HostSessionRef, signal: AbortSignal): Promise<void>;

  restore(snapshot: RuntimeSnapshot, signal: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Activation state (exposed to UI subscribers)
// ---------------------------------------------------------------------------

export interface ActivationState {
  readonly stage: ActivationStage;
  readonly requestId: string | null;
  readonly targetRef: HostSessionRef | null;
  readonly startedAt: number | null;
  readonly error: ActivationError | null;
}

// ---------------------------------------------------------------------------
// Activation result
// ---------------------------------------------------------------------------

export type ActivationResultKind = 'success' | 'no-op' | 'failure' | 'cancelled';

export interface ActivationResult {
  readonly kind: ActivationResultKind;
  readonly requestId: string;
  readonly error?: ActivationError;
  readonly rollbackError?: ActivationError;
}

// ---------------------------------------------------------------------------
// Activation error (structured, safe for logging)
// ---------------------------------------------------------------------------

export interface ActivationError {
  readonly code: ActivationErrorCode;
  readonly message: string;
  readonly stage: ActivationStage;
  readonly hostId?: HostId;
  readonly requestId?: string;
  readonly cause?: unknown;
}

// ---------------------------------------------------------------------------
// Safe logger
// ---------------------------------------------------------------------------

export interface SafeActivationLogger {
  debug(stage: ActivationStage, message: string, meta?: Record<string, unknown>): void;
  info(stage: ActivationStage, message: string, meta?: Record<string, unknown>): void;
  warn(stage: ActivationStage, message: string, meta?: Record<string, unknown>): void;
  error(stage: ActivationStage, message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Controller public API
// ---------------------------------------------------------------------------

export interface HostActivationController {
  activateSession(ref: HostSessionRef): Promise<ActivationResult>;
  cancelCurrent(reason?: string): void;
  getState(): ActivationState;
  subscribe(listener: (state: ActivationState) => void): () => void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Controller options
// ---------------------------------------------------------------------------

export interface HostActivationControllerOptions {
  adapter: RuntimeActivationAdapter;
  getHost: (hostId: HostId) => HostDescriptor | undefined;
  clearUnread: (ref: HostSessionRef) => void;
  timeoutMs?: number;
  rollbackTimeoutMs?: number;
  logger?: SafeActivationLogger;
}
