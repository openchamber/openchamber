export const GIT_EXECUTION_ERROR_CODES = Object.freeze({
  OVERLOADED: 'GIT_EXECUTION_OVERLOADED',
  CANCELLED: 'GIT_EXECUTION_CANCELLED',
  QUEUE_TIMEOUT: 'GIT_EXECUTION_QUEUE_TIMEOUT',
  REENTRANCY: 'GIT_EXECUTION_REENTRANCY',
});

const GIT_EXECUTION_ERROR_CODE_SET = new Set(Object.values(GIT_EXECUTION_ERROR_CODES));

export const isGitExecutionError = (error) => (
  Boolean(error)
  && typeof error === 'object'
  && GIT_EXECUTION_ERROR_CODE_SET.has(error.code)
);

class GitExecutionError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class GitExecutionOverloadedError extends GitExecutionError {
  constructor(message = 'Git execution capacity is exhausted', details = undefined) {
    super(message, GIT_EXECUTION_ERROR_CODES.OVERLOADED, details);
  }
}

export class GitExecutionCancelledError extends GitExecutionError {
  constructor(message = 'Git execution was cancelled', details = undefined) {
    super(message, GIT_EXECUTION_ERROR_CODES.CANCELLED, details);
  }
}

export class GitExecutionQueueTimeoutError extends GitExecutionError {
  constructor(message = 'Git execution timed out while queued', details = undefined) {
    super(message, GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT, details);
  }
}

export class GitExecutionReentrancyError extends GitExecutionError {
  constructor(message = 'Nested Git execution is incompatible with the active lease', details = undefined) {
    super(message, GIT_EXECUTION_ERROR_CODES.REENTRANCY, details);
  }
}
