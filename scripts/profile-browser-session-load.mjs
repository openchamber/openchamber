export function projectSessionLoadPerformance(events, recordingStartedAt) {
  const sourceEvents = Array.isArray(events) ? events : []
  if (!Number.isFinite(recordingStartedAt)) {
    return { bufferAtCapacity: sourceEvents.length >= 1000, events: [] }
  }
  const allowedOperations = new Set([
    "bootstrap.directory",
    "bootstrap.sessions.all",
    "bootstrap.sessions.archived",
    "bootstrap.sessions.roots",
    "global-sessions.active",
    "global-sessions.archived",
    "session-messages.initial",
    "session-messages.older",
    "session-messages.page",
    "session-messages.refresh",
    "session-messages.visible",
    "session-prefetch",
  ])
  const allowedCallers = new Set([
    "action-demand",
    "current-directory",
    "initial",
    "initial-page",
    "known-project",
    "known-worktree",
    "older",
    "pagination",
    "prefetch",
    "project-expanded",
    "refresh",
    "selected-session",
    "server-connected",
    "worktree-expanded",
  ])
  const allowedOutcomes = new Set(["complete", "error", "stale", "deduplicated", "canceled"])
  const optionalNonNegativeNumber = (value) => Number.isFinite(value) && value >= 0 ? value : undefined
  const optionalNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : undefined
  return {
    bufferAtCapacity: sourceEvents.length >= 1000,
    events: sourceEvents.flatMap((event) => {
      const {
        operation,
        caller,
        queuedMs,
        requestLimit,
        cursorPresent,
        durationMs,
        outcome,
        retryCount,
        recordCount,
        at,
      } = event && typeof event === "object" ? event : {}
      if (!allowedOperations.has(operation)
        || !allowedCallers.has(caller)
        || !allowedOutcomes.has(outcome)
        || !Number.isFinite(durationMs)
        || durationMs < 0
        || !Number.isFinite(at)) {
        return []
      }
      const projected = {
        operation,
        caller,
        durationMs,
        outcome,
        offsetMs: Math.max(0, at - recordingStartedAt),
      }
      const safeQueuedMs = optionalNonNegativeNumber(queuedMs)
      const safeRequestLimit = optionalNonNegativeInteger(requestLimit)
      const safeRetryCount = optionalNonNegativeInteger(retryCount)
      const safeRecordCount = optionalNonNegativeInteger(recordCount)
      if (safeQueuedMs !== undefined) projected.queuedMs = safeQueuedMs
      if (safeRequestLimit !== undefined) projected.requestLimit = safeRequestLimit
      if (typeof cursorPresent === "boolean") projected.cursorPresent = cursorPresent
      if (safeRetryCount !== undefined) projected.retryCount = safeRetryCount
      if (safeRecordCount !== undefined) projected.recordCount = safeRecordCount
      return [projected]
    }),
  }
}
