const STORAGE_KEY = "openchamber_performance_trace"
const MAX_EVENTS = 512
const MAX_FIELD_STRING_LENGTH = 96
const MAX_CONTEXT_LINKS = 8

type PerformanceTraceFieldValue = string | number | boolean
export type PerformanceTraceFields = Record<string, PerformanceTraceFieldValue | undefined>

type PerformanceTraceEvent = {
  seq: number
  atMs: number
  name: string
  kind: "event" | "span"
  durationMs?: number
  traceId?: string
  spanId?: string
  fields: Record<string, PerformanceTraceFieldValue>
}

export type PerformanceTraceLink = {
  name: string
  traceId?: string
  atMs: number
  durationMs: number
}

type PerformanceTraceSnapshot = {
  enabled: boolean
  startedAt: number | null
  lastUpdatedAt: number | null
  durationMs: number
  events: PerformanceTraceEvent[]
  droppedEvents: number
  openSpans: number
}

export type PerformanceTraceSpan = {
  traceId?: string
  spanId?: string
  child: (name: string, fields?: PerformanceTraceFields) => PerformanceTraceSpan
  end: (fields?: PerformanceTraceFields) => void
}

type PerformanceTraceState = {
  startedAt: number
  startedAtPerf: number
  lastUpdatedAt: number
  nextSequence: number
  nextTraceId: number
  nextSpanId: number
  droppedEvents: number
  events: PerformanceTraceEvent[]
  openSpans: Map<string, true>
}

declare global {
  interface Window {
    __openchamberPerformanceTrace?: {
      setEnabled: (enabled: boolean) => void
      reset: () => void
      getSnapshot: () => PerformanceTraceSnapshot
    }
  }
}

const now = (): number => (
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
)

const round = (value: number): number => Number(value.toFixed(3))

const readInitialEnabled = (): boolean => {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

const createState = (): PerformanceTraceState => {
  const startedAtPerf = now()
  return {
    startedAt: Date.now(),
    startedAtPerf,
    lastUpdatedAt: Date.now(),
    nextSequence: 1,
    nextTraceId: 1,
    nextSpanId: 1,
    droppedEvents: 0,
    events: [],
    openSpans: new Map(),
  }
}

let enabled = readInitialEnabled()
let state: PerformanceTraceState | null = enabled ? createState() : null

const sanitizeName = (name: string): string => name.trim().slice(0, MAX_FIELD_STRING_LENGTH)

const sanitizeFields = (fields: PerformanceTraceFields | undefined): Record<string, PerformanceTraceFieldValue> => {
  if (!fields) return {}
  const result: Record<string, PerformanceTraceFieldValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!key || value === undefined) continue
    const safeKey = key.trim().slice(0, MAX_FIELD_STRING_LENGTH)
    if (!safeKey) continue
    if (typeof value === "string") {
      result[safeKey] = value.replace(/[\r\n\t]/g, " ").slice(0, MAX_FIELD_STRING_LENGTH)
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[safeKey] = round(value)
    } else if (typeof value === "boolean") {
      result[safeKey] = value
    }
  }
  return result
}

type AppendEventInput = Omit<PerformanceTraceEvent, "seq" | "atMs" | "fields"> & {
  atPerf?: number
  fields?: PerformanceTraceFields
}

const appendEvent = (input: AppendEventInput): void => {
  if (!state) return
  const event: PerformanceTraceEvent = {
    seq: state.nextSequence++,
    atMs: round(Math.max(0, (input.atPerf ?? now()) - state.startedAtPerf)),
    name: sanitizeName(input.name),
    kind: input.kind,
    ...(input.durationMs !== undefined ? { durationMs: round(Math.max(0, input.durationMs)) } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.spanId ? { spanId: input.spanId } : {}),
    fields: sanitizeFields(input.fields),
  }
  if (state.events.length >= MAX_EVENTS) {
    state.events.shift()
    state.droppedEvents += 1
  }
  state.events.push(event)
  state.lastUpdatedAt = Date.now()
}

const noopSpan: PerformanceTraceSpan = {
  child: () => noopSpan,
  end: () => undefined,
}

export const startPerformanceTraceSpan = (
  name: string,
  fields?: PerformanceTraceFields,
  parentTraceId?: string,
): PerformanceTraceSpan => {
  if (!enabled || !state || !sanitizeName(name)) return noopSpan

  const spanState = state
  const traceId = parentTraceId || `t${state.nextTraceId++}`
  const spanId = `s${state.nextSpanId++}`
  const startedAt = now()
  state.openSpans.set(spanId, true)
  let ended = false

  return {
    traceId,
    spanId,
    child: (childName, childFields) => startPerformanceTraceSpan(childName, childFields, traceId),
    end: (endFields) => {
      if (ended) return
      ended = true
      spanState.openSpans.delete(spanId)
      if (state !== spanState || !enabled) return
      appendEvent({
        name,
        kind: "span",
        durationMs: now() - startedAt,
        traceId,
        spanId,
        fields: { ...fields, ...endFields },
      })
    },
  }
}

export const recordPerformanceTraceEvent = (
  name: string,
  fields?: PerformanceTraceFields,
  durationMs?: number,
  traceId?: string,
): void => {
  if (!enabled || !state || !sanitizeName(name)) return
  appendEvent({
    name,
    kind: "event",
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(traceId ? { traceId } : {}),
    fields,
  })
}

export const getRecentPerformanceTraceLinks = (
  windowMs = 1_000,
  limit = MAX_CONTEXT_LINKS,
): PerformanceTraceLink[] => {
  if (!enabled || !state || windowMs < 0 || limit <= 0) return []
  const currentAtMs = Math.max(0, now() - state.startedAtPerf)
  const cutoffMs = currentAtMs - windowMs
  return state.events
    .filter((event) => (
      event.durationMs !== undefined
      && event.atMs <= currentAtMs
      && event.atMs + event.durationMs >= cutoffMs
    ))
    .slice(-limit)
    .map((event) => ({
      name: event.name,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      atMs: event.atMs,
      durationMs: event.durationMs ?? 0,
    }))
}

const emptySnapshot = (): PerformanceTraceSnapshot => ({
  enabled: false,
  startedAt: null,
  lastUpdatedAt: null,
  durationMs: 0,
  events: [],
  droppedEvents: 0,
  openSpans: 0,
})

export const getPerformanceTraceSnapshot = (): PerformanceTraceSnapshot => {
  if (!enabled || !state) return emptySnapshot()
  return {
    enabled: true,
    startedAt: state.startedAt,
    lastUpdatedAt: state.lastUpdatedAt,
    durationMs: Math.max(0, Date.now() - state.startedAt),
    events: state.events.map((event) => ({
      ...event,
      fields: { ...event.fields },
    })),
    droppedEvents: state.droppedEvents,
    openSpans: state.openSpans.size,
  }
}

export const resetPerformanceTrace = (): void => {
  if (enabled) state = createState()
}

export const setPerformanceTraceEnabled = (nextEnabled: boolean): void => {
  if (nextEnabled === enabled) {
    if (nextEnabled) resetPerformanceTrace()
    return
  }

  enabled = nextEnabled
  state = nextEnabled ? createState() : null
  if (typeof window === "undefined") return

  try {
    if (nextEnabled) window.localStorage.setItem(STORAGE_KEY, "1")
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures in the opt-in debug helper.
  }
}

if (typeof window !== "undefined") {
  window.__openchamberPerformanceTrace = {
    setEnabled: setPerformanceTraceEnabled,
    reset: resetPerformanceTrace,
    getSnapshot: getPerformanceTraceSnapshot,
  }
}
