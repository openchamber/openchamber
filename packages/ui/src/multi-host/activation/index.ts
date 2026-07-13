/**
 * Activation module — public API barrel.
 *
 * Import from '@/multi-host/activation' to consume types, factory,
 * and adapter contract. Do not import internal modules directly.
 */

// -- Types ------------------------------------------------------------------
export type {
  ActivationError,
  ActivationErrorCode,
  ActivationResult,
  ActivationResultKind,
  ActivationStage,
  ActivationState,
  HostActivationController,
  HostActivationControllerOptions,
  RuntimeActivationAdapter,
  RuntimeSnapshot,
  SafeActivationLogger,
} from './types';

// -- Error helpers ----------------------------------------------------------
export {
  createActivationError,
  redactMeta,
  safeHostLabel,
  hostNotFound,
  hostOffline,
  unsupportedTransport,
  authenticationFailed,
  validationFailed,
  switchFailed,
  runtimeReadyTimeout,
  projectNotFound,
  directoryNotFound,
  sessionNotFound,
  navigationFailed,
  selectionFailed,
  cancelled,
  controllerDisposed,
  rollbackFailed,
  unknownError,
} from './activation-errors';

// -- Logger -----------------------------------------------------------------
export { createSafeActivationLogger, noopLogger } from './safe-activation-logger';

// -- Controller factory -----------------------------------------------------
export { createHostActivationController } from './host-activation-controller';
