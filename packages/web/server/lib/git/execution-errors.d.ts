export const GIT_EXECUTION_ERROR_CODES: Readonly<{
  OVERLOADED: 'GIT_EXECUTION_OVERLOADED';
  CANCELLED: 'GIT_EXECUTION_CANCELLED';
  QUEUE_TIMEOUT: 'GIT_EXECUTION_QUEUE_TIMEOUT';
  REENTRANCY: 'GIT_EXECUTION_REENTRANCY';
}>;

export type GitExecutionErrorCode = (
  typeof GIT_EXECUTION_ERROR_CODES[keyof typeof GIT_EXECUTION_ERROR_CODES]
);

export type GitExecutionErrorDetails = Readonly<Record<string, unknown>>;

export type GitExecutionError = Error & {
  readonly code: GitExecutionErrorCode;
  readonly details?: GitExecutionErrorDetails;
};

export function isGitExecutionError(error: unknown): error is GitExecutionError;

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
