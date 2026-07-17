export const GIT_EXECUTION_ERROR_CODES = Object.freeze({
  OVERLOADED: 'GIT_EXECUTION_OVERLOADED',
  CANCELLED: 'GIT_EXECUTION_CANCELLED',
  QUEUE_TIMEOUT: 'GIT_EXECUTION_QUEUE_TIMEOUT',
  REENTRANCY: 'GIT_EXECUTION_REENTRANCY',
} as const);

type GitExecutionErrorCode = typeof GIT_EXECUTION_ERROR_CODES[keyof typeof GIT_EXECUTION_ERROR_CODES];
export type GitExecutionErrorDetails = Readonly<Record<string, unknown>>;

const GIT_EXECUTION_ERROR_CODE_SET = new Set<GitExecutionErrorCode>(Object.values(GIT_EXECUTION_ERROR_CODES));

class GitExecutionError extends Error {
  readonly code: GitExecutionErrorCode;
  readonly details?: GitExecutionErrorDetails;

  constructor(message: string, code: GitExecutionErrorCode, details?: GitExecutionErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export const isGitExecutionError = (error: unknown): error is GitExecutionError => (
  error instanceof GitExecutionError
  || (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && GIT_EXECUTION_ERROR_CODE_SET.has((error as { code: GitExecutionErrorCode }).code)
  )
);

export class GitExecutionOverloadedError extends GitExecutionError {
  constructor(message = 'Git execution capacity is exhausted', details?: GitExecutionErrorDetails) {
    super(message, GIT_EXECUTION_ERROR_CODES.OVERLOADED, details);
  }
}

export class GitExecutionCancelledError extends GitExecutionError {
  constructor(message = 'Git execution was cancelled', details?: GitExecutionErrorDetails) {
    super(message, GIT_EXECUTION_ERROR_CODES.CANCELLED, details);
  }
}

export class GitExecutionQueueTimeoutError extends GitExecutionError {
  constructor(message = 'Git execution timed out while queued', details?: GitExecutionErrorDetails) {
    super(message, GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT, details);
  }
}

export class GitExecutionReentrancyError extends GitExecutionError {
  constructor(message = 'Nested Git execution is incompatible with the active lease', details?: GitExecutionErrorDetails) {
    super(message, GIT_EXECUTION_ERROR_CODES.REENTRANCY, details);
  }
}
