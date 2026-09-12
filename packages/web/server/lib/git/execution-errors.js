const defineError = (name, code, defaultMessage) => class extends Error {
  constructor(message = defaultMessage, details) {
    super(message);
    this.name = name;
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
};

export const GIT_EXECUTION_ERROR_CODES = Object.freeze({
  OVERLOADED: 'GIT_EXECUTION_OVERLOADED',
  CANCELLED: 'GIT_EXECUTION_CANCELLED',
  QUEUE_TIMEOUT: 'GIT_EXECUTION_QUEUE_TIMEOUT',
  REENTRANCY: 'GIT_EXECUTION_REENTRANCY',
});

export const GitExecutionOverloadedError = defineError(
  'GitExecutionOverloadedError',
  GIT_EXECUTION_ERROR_CODES.OVERLOADED,
  'Git execution queue is overloaded',
);

export const GitExecutionCancelledError = defineError(
  'GitExecutionCancelledError',
  GIT_EXECUTION_ERROR_CODES.CANCELLED,
  'Git execution was cancelled',
);

export const GitExecutionQueueTimeoutError = defineError(
  'GitExecutionQueueTimeoutError',
  GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT,
  'Git execution queue wait timed out',
);

export const GitExecutionReentrancyError = defineError(
  'GitExecutionReentrancyError',
  GIT_EXECUTION_ERROR_CODES.REENTRANCY,
  'Git execution cannot re-enter an incompatible lease',
);

export const isGitExecutionError = (error) => Boolean(
  error
  && typeof error === 'object'
  && typeof error.code === 'string'
  && Object.values(GIT_EXECUTION_ERROR_CODES).includes(error.code),
);
