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

const processTreeMetadataSources = (value) => {
  if (!value || Object(value) !== value) return [];
  const nested = value.error;
  return nested && Object(nested) === nested ? [value, nested] : [value];
};

export const getGitProcessCleanupReconciliation = (value) => {
  for (const metadata of processTreeMetadataSources(value)) {
    const reconciliation = metadata.cleanupReconciliation;
    if (!reconciliation || Object(reconciliation) !== reconciliation) continue;
    if (!reconciliation.promise || Object.prototype.toString.call(reconciliation.retire) !== '[object Function]') continue;
    return reconciliation;
  }
  return null;
};

export const chainGitProcessCleanupReconciliation = (reconciliation, cleanup) => {
  if (!reconciliation || !(cleanup instanceof Function)) {
    return reconciliation;
  }
  return {
    promise: Promise.resolve(reconciliation.promise).then(cleanup),
    retire: reconciliation.retire,
  };
};

/**
 * Keep process-tree termination facts when a raw Git result crosses an
 * adapter boundary. A cleanup failure is not an ordinary Git exit, because
 * the caller still owns a process and the read or lease cannot be released.
 */
export const copyGitProcessMetadata = (target, source) => {
  for (const metadata of processTreeMetadataSources(source)) {
    if (metadata.cleanupBlocked === true) target.cleanupBlocked = true;
    if (metadata.descendantsTerminated === false) target.descendantsTerminated = false;
    if (metadata.rootClosed === true || metadata.rootClosed === false) target.rootClosed = metadata.rootClosed;
    if (Number.isInteger(metadata.pid)) target.pid = metadata.pid;
    if (metadata.code !== undefined && metadata.code !== null) target.code = metadata.code;
    if (metadata.cause !== undefined) target.cause = metadata.cause;
    if (metadata.rootError !== undefined) target.rootError = metadata.rootError;
    if (metadata.operationError !== undefined) target.operationError = metadata.operationError;
    if (metadata.cleanupReconciliation !== undefined) {
      target.cleanupReconciliation = metadata.cleanupReconciliation;
    }
  }
  return target;
};

export const isGitProcessCleanupBlocked = (value) => {
  return processTreeMetadataSources(value).some((metadata) => (
    metadata.cleanupBlocked === true
    || (metadata.descendantsTerminated === false && metadata.code === 'ERR_PROCESS_TREE_TERMINATION')
  ));
};

export const createGitProcessError = (result, fallbackMessage = 'Git command failed') => {
  const error = Object.assign(
    new Error(
      result?.message
        || result?.stderr
        || result?.stdout
        || fallbackMessage,
    ),
    {
      code: result?.code ?? result?.exitCode ?? 'GIT_COMMAND_FAILED',
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
    },
  );
  return copyGitProcessMetadata(error, result);
};

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
  error != null
  && Object.values(GIT_EXECUTION_ERROR_CODES).includes(Object(error).code),
);
