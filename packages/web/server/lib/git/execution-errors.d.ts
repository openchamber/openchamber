export const GIT_EXECUTION_ERROR_CODES: Readonly<{
  OVERLOADED: 'GIT_EXECUTION_OVERLOADED';
  CANCELLED: 'GIT_EXECUTION_CANCELLED';
  QUEUE_TIMEOUT: 'GIT_EXECUTION_QUEUE_TIMEOUT';
  REENTRANCY: 'GIT_EXECUTION_REENTRANCY';
}>;

export type GitExecutionErrorCode = typeof GIT_EXECUTION_ERROR_CODES[keyof typeof GIT_EXECUTION_ERROR_CODES];
export type GitExecutionErrorDetails = Readonly<{ [key: string]: string | number | boolean | null | undefined }>;
export type GitExecutionError = Error & {
  readonly code: GitExecutionErrorCode;
  readonly details?: GitExecutionErrorDetails;
};

export type GitExecutionErrorInput = Error | {
  readonly code?: GitExecutionErrorCode;
  readonly details?: GitExecutionErrorDetails;
} | null | undefined;

export type GitProcessTerminationMetadata = {
  cleanupBlocked?: boolean;
  descendantsTerminated?: boolean;
  rootClosed?: boolean;
  pid?: number;
  code?: string | number;
  cause?: unknown;
  rootError?: Error;
  operationError?: Error;
  cleanupReconciliation?: GitProcessCleanupReconciliation;
};

export type GitProcessCleanupReconciliation = {
  promise: Promise<unknown>;
  retire: () => void;
};

export type GitProcessMetadataInput = (Error & GitProcessTerminationMetadata & {
  error?: GitProcessMetadataInput;
}) | (GitProcessTerminationMetadata & {
  error?: GitProcessMetadataInput;
}) | null | undefined;

export type GitProcessResultInput = GitProcessMetadataInput & {
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export function copyGitProcessMetadata<T>(target: T, source: GitProcessMetadataInput): T;
export function getGitProcessCleanupReconciliation(value: GitProcessMetadataInput): GitProcessCleanupReconciliation | null;
export function chainGitProcessCleanupReconciliation(
  reconciliation: GitProcessCleanupReconciliation,
  cleanup: () => void | Promise<void>,
): GitProcessCleanupReconciliation;
export function chainGitProcessCleanupReconciliation(
  reconciliation: null | undefined,
  cleanup: () => void | Promise<void>,
): null | undefined;
export function isGitProcessCleanupBlocked(value: GitProcessMetadataInput): boolean;
export function isGitProcessCleanupBlocked<T>(value: T): boolean;
export function createGitProcessError(result: GitProcessResultInput, fallbackMessage?: string): Error & Omit<GitProcessTerminationMetadata, 'cause'> & {
  code: string | number;
  stdout: string;
  stderr: string;
};

export function isGitExecutionError(error: GitExecutionErrorInput): error is GitExecutionError;

export class GitExecutionOverloadedError extends Error {
  readonly code: typeof GIT_EXECUTION_ERROR_CODES.OVERLOADED;
  readonly details?: GitExecutionErrorDetails;
  constructor(message?: string, details?: GitExecutionErrorDetails);
}

export class GitExecutionCancelledError extends Error {
  readonly code: typeof GIT_EXECUTION_ERROR_CODES.CANCELLED;
  readonly details?: GitExecutionErrorDetails;
  constructor(message?: string, details?: GitExecutionErrorDetails);
}

export class GitExecutionQueueTimeoutError extends Error {
  readonly code: typeof GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT;
  readonly details?: GitExecutionErrorDetails;
  constructor(message?: string, details?: GitExecutionErrorDetails);
}

export class GitExecutionReentrancyError extends Error {
  readonly code: typeof GIT_EXECUTION_ERROR_CODES.REENTRANCY;
  readonly details?: GitExecutionErrorDetails;
  constructor(message?: string, details?: GitExecutionErrorDetails);
}
