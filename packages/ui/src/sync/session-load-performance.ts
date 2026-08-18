const STORAGE_KEY = "openchamber_session_load_perf"
const MAX_EVENTS = 1_000
const ALLOWED_OPERATIONS = new Set([
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
const ALLOWED_CALLERS = new Set([
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
const ALLOWED_OUTCOMES = new Set<SessionLoadPerformanceOutcome>([
  "complete",
  "error",
  "stale",
  "deduplicated",
  "canceled",
])

type SessionLoadPerformanceOutcome = "complete" | "error" | "stale" | "deduplicated" | "canceled"

type SessionLoadPerformanceEvent = {
  operation: string
  caller?: string
  queuedMs?: number
  requestLimit?: number
  cursorPresent?: boolean
  durationMs: number
  outcome: SessionLoadPerformanceOutcome
  retryCount?: number
  recordCount?: number
  at: number
}

type SessionLoadPerformanceState = {
  events: SessionLoadPerformanceEvent[]
}

declare global {
  interface Window {
    __openchamberSessionLoadPerformance?: SessionLoadPerformanceState
  }
}

const isSessionLoadPerformanceEnabled = (): boolean => {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

const now = (): number => typeof performance !== "undefined" && typeof performance.now === "function"
  ? performance.now()
  : Date.now()

const nonNegativeNumber = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
)
const nonNegativeInteger = (value: unknown): number | undefined => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined
)

export function startSessionLoadPerformanceEvent(input: Omit<SessionLoadPerformanceEvent, "at" | "durationMs" | "outcome">) {
  if (
    !isSessionLoadPerformanceEnabled()
    || !ALLOWED_OPERATIONS.has(input.operation)
    || (input.caller !== undefined && !ALLOWED_CALLERS.has(input.caller))
  ) return () => undefined
  const startedAt = now()
  return (
    outcome: SessionLoadPerformanceOutcome,
    details?: Partial<Pick<SessionLoadPerformanceEvent, "retryCount" | "recordCount">>,
  ) => {
    if (typeof window === "undefined" || !ALLOWED_OUTCOMES.has(outcome)) return
    const state = window.__openchamberSessionLoadPerformance ?? { events: [] }
    const queuedMs = nonNegativeNumber(input.queuedMs)
    const requestLimit = nonNegativeInteger(input.requestLimit)
    const retryCount = nonNegativeInteger(details?.retryCount ?? input.retryCount)
    const recordCount = nonNegativeInteger(details?.recordCount ?? input.recordCount)
    state.events.push({
      operation: input.operation,
      ...(input.caller !== undefined ? { caller: input.caller } : {}),
      ...(queuedMs !== undefined ? { queuedMs } : {}),
      ...(requestLimit !== undefined ? { requestLimit } : {}),
      ...(typeof input.cursorPresent === "boolean" ? { cursorPresent: input.cursorPresent } : {}),
      outcome,
      durationMs: Math.max(0, now() - startedAt),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(recordCount !== undefined ? { recordCount } : {}),
      at: Date.now(),
    })
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
    window.__openchamberSessionLoadPerformance = state
  }
}

type FirstVisibleSessionPerformanceDependencies = {
  enabled: () => boolean
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (frame: number) => void
  markVisible: () => void
  startEvent: typeof startSessionLoadPerformanceEvent
}

const FIRST_VISIBLE_MARK = "openchamber.chat.first_message_visible"

export function createFirstVisibleSessionPerformanceTracker(
  dependencies?: Partial<FirstVisibleSessionPerformanceDependencies>,
) {
  const enabled = dependencies?.enabled ?? isSessionLoadPerformanceEnabled
  const requestFrame = dependencies?.requestFrame ?? ((callback) => window.requestAnimationFrame(callback))
  const cancelFrame = dependencies?.cancelFrame ?? ((frame) => window.cancelAnimationFrame(frame))
  const markVisible = dependencies?.markVisible ?? (() => {
    performance.mark(FIRST_VISIBLE_MARK)
    performance.clearMarks(FIRST_VISIBLE_MARK)
  })
  const startEvent = dependencies?.startEvent ?? startSessionLoadPerformanceEvent
  const measuredKeys = new Set<string>()
  let pending: { key: string; frame: number } | null = null

  return {
    schedule(key: string, recordCount: number): () => void {
      if (!enabled() || measuredKeys.has(key)) return () => undefined
      if (pending) {
        cancelFrame(pending.frame)
        pending = null
      }
      const finishPerformanceEvent = startEvent({
        operation: "session-messages.visible",
        caller: "selected-session",
        recordCount,
      })
      const frame = requestFrame(() => {
        if (pending?.key !== key || pending.frame !== frame) return
        pending = null
        measuredKeys.add(key)
        if (measuredKeys.size > MAX_EVENTS) {
          measuredKeys.delete(measuredKeys.values().next().value!)
        }
        markVisible()
        finishPerformanceEvent("complete")
      })
      pending = { key, frame }

      return () => {
        if (pending?.key !== key || pending.frame !== frame) return
        cancelFrame(frame)
        pending = null
      }
    },
  }
}
