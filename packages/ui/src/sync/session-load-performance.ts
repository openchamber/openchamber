const STORAGE_KEY = "openchamber_session_load_perf"
const MAX_EVENTS = 1_000

type SessionLoadPerformanceOutcome = "complete" | "error" | "stale" | "deduplicated" | "canceled"

type SessionLoadPerformanceEvent = {
  operation: string
  runtimeKey?: string
  directory?: string
  sessionID?: string
  caller?: string
  queuedMs?: number
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

const enabled = (): boolean => {
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

export function startSessionLoadPerformanceEvent(input: Omit<SessionLoadPerformanceEvent, "at" | "durationMs" | "outcome">) {
  if (!enabled()) return () => undefined
  const startedAt = now()
  return (
    outcome: SessionLoadPerformanceOutcome,
    details?: Partial<Pick<SessionLoadPerformanceEvent, "retryCount" | "recordCount">>,
  ) => {
    if (typeof window === "undefined") return
    const state = window.__openchamberSessionLoadPerformance ?? { events: [] }
    state.events.push({
      ...input,
      ...details,
      outcome,
      durationMs: Math.max(0, now() - startedAt),
      at: Date.now(),
    })
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
    window.__openchamberSessionLoadPerformance = state
  }
}
