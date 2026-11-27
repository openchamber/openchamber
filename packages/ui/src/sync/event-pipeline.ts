
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import { openchamberNotificationSchema } from "@/lib/notifications/notificationShapes"
import { opencodeClient } from "@/lib/opencode/client"
import { GLOBAL_EVENT_DIRECTORY, hostTurnStart, routeWireEvent, syncEventSessionID, type SyncEvent } from "@/lib/opencode/events"
import { createTurnBoundaryOrder, wireEventSchema, type StaleWireEventCheck } from "@/lib/opencode/wire-admission"
import type { Metadata } from "@/lib/opencode/model"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { useAuthSessionStore, waitForAuthSession } from "@/lib/runtime-auth-expiry"
import { type RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { openRuntimeWebSocket } from "@/lib/relay/runtime-socket"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isServerOffline } from "@/lib/server-offline"
import { spaceCreationStepSchema, spaceTaskTitleSchema, type SpaceTaskTitle } from "@/lib/spaces/spaces-api"
import { workflowRunSchema } from "@/lib/workflows/model"
import { syncDebug } from "./debug"
import { countSyncPerformance } from "./performance-diagnostics"

const FLUSH_FRAME_MS = 100
const BACKPRESSURE_FLUSH_FRAME_MS = 200
const BACKPRESSURE_MODE_MS = 10_000
const STREAM_YIELD_MS = 8
const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const WS_FALLBACK_WINDOW_MS = 60_000
const WS_PROVEN_OPEN_FAILURES_BEFORE_FALLBACK = 3
const DEFAULT_WS_READY_TIMEOUT_MS = 2_000
const RETRY_BACKOFF_BASE_MS = 250
const RETRY_BACKOFF_CAP_VISIBLE_MS = 5_000
const RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000
const RETRY_BACKOFF_MAX_EXPONENT = 8

type EventPipelineDelivery = {
  onEvent: (directory: string, payload: SyncEvent) => void
  onEvents?: never
} | {
  onEvent?: never
  onEvents: (directory: string, payloads: readonly SyncEvent[]) => void
}

export type EventPipelineInput = {
  sdk: OpenCodeClient
  routeDirectory?: (directory: string, payload: SyncEvent) => string
  onReconnect?: (details: { replayReset: boolean; replayed: boolean }) => void
  onDisconnect?: (reason: string) => void
  onTransportSwitch?: () => void
  onSpaceStream?: (details: { spaceId: string; status: "connected" | "disconnected"; wasReady: boolean }) => void
  onSpaceProgress?: (details: SpaceProgress) => void
  onSpaceTaskTitle?: (spaceId: string, taskTitle: SpaceTaskTitle | null) => void
  onSpaceSetup?: (spaceId: string) => void
  onSpacePermissionStream?: (spaceId: string) => void
  onStreamActivity?: () => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
} & EventPipelineDelivery

export type EventPipeline = {
  cleanup: () => void
  reconnect: (reason?: string) => void
}

const wsFrameSchema = z.object({
  type: z.enum(["ready", "event", "error", "backpressure"]),
  replayReset: z.boolean().optional(),
  replayed: z.boolean().optional(),
  cursor: z.string().optional(),
  payload: z.unknown().optional(),
  eventId: z.string().optional(),
  directory: z.string().optional(),
  message: z.string().optional(),
})

const openchamberStatusSchema = z.object({
  type: z.literal("openchamber:session-status"),
  properties: z.object({
    sessionID: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    status: z.enum(["idle", "busy", "retry"]),
    metadata: z.object({ attempt: z.number(), message: z.string(), next: z.number() }).partial().optional(),
    timestamp: z.number().optional(),
    turnStartedAt: z.number().optional(),
  }),
})

const openchamberArchivedSchema = z.object({
  type: z.literal("openchamber:session-archived"),
  properties: z.object({ sessionID: z.string().min(1), archivedAt: z.number().nullable() }),
})

const openchamberMetadataSchema = z.object({
  type: z.literal("openchamber:session-metadata"),
  properties: z.object({ sessionID: z.string().min(1), metadata: z.record(z.string(), z.unknown()) }),
})

const openchamberPageWaitingSchema = z.object({
  type: z.literal("openchamber:page-waiting"),
  properties: z.object({
    sessionID: z.string().min(1),
    directory: z.string().min(1).nullable().catch(null),
    page: z.object({ id: z.string().min(1), title: z.string() }),
  }),
})

const openchamberPageSettledSchema = z.object({
  type: z.literal("openchamber:page-settled"),
  properties: z.object({ sessionID: z.string().min(1), pageID: z.string().min(1) }),
})

const openchamberSessionAssistSchema = z.object({
  type: z.literal("openchamber:session-assist"),
  properties: z.object({
    sessionID: z.string().min(1),
    directory: z.string().min(1).nullable().catch(null),
    pending: z.boolean(),
  }),
})

const openchamberWorkflowRunSchema = z.object({
  type: z.literal("openchamber:workflow-run"),
  properties: z.object({ run: workflowRunSchema }),
})

const openchamberWorkflowRunRemovedSchema = z.object({
  type: z.literal("openchamber:workflow-run-removed"),
  properties: z.object({ runId: z.string().min(1), parentSessionId: z.string().min(1) }),
})

const openchamberSpaceStreamSchema = z.object({
  type: z.literal("openchamber:space-stream"),
  properties: z.object({
    spaceId: z.string().regex(/^[0-9a-f]{12}$/),
    status: z.enum(["connected", "disconnected"]),
    wasReady: z.boolean(),
  }),
})

const openchamberSpaceProgressSchema = z.object({
  type: z.literal("openchamber:space-progress"),
  properties: z.object({
    spaceId: z.string().regex(/^[0-9a-f]{12}$/),
    step: z.union([spaceCreationStepSchema, z.literal("failed"), z.literal("removed")]),
    failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
})

const openchamberSpaceTaskTitleSchema = z.object({
  type: z.literal("openchamber:space-task-title.updated"),
  properties: z.object({ spaceId: z.string().regex(/^[0-9a-f]{12}$/), taskTitle: spaceTaskTitleSchema.nullable() }),
})

export type SpaceProgress = z.infer<typeof openchamberSpaceProgressSchema>["properties"]

const openchamberSpaceSetupSchema = z.object({
  type: z.literal("openchamber:space-setup"),
  properties: z.object({ spaceId: z.string().regex(/^[0-9a-f]{12}$/) }),
})

const openchamberAutoAcceptSchema = z.object({
  type: z.literal("openchamber:permission-auto-accept.updated"),
  properties: z.object({
    sessions: z.record(z.string(), z.boolean()),
    modes: z.record(z.string(), z.enum(["ask", "safety", "auto"])).optional(),
    revision: z.number().optional(),
    spaceId: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  }),
})

const openchamberSpacePermissionStreamSchema = z.object({
  type: z.literal("openchamber:space-permission-stream"),
  properties: z.object({ spaceId: z.string().regex(/^[0-9a-f]{12}$/), status: z.literal("connected") }),
})

const openchamberLeftForUserSchema = z.object({
  type: z.literal("openchamber:permission-auto-accept.left-for-user"),
  properties: z.object({
    permissionId: z.string().min(1),
    sessionId: z.string().min(1),
    directory: z.string().nullable(),
    spaceId: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  }),
})

const payloadTypeSchema = z.object({ type: z.string() })

const OPENCHAMBER_TYPE_PREFIX = "openchamber:"

function translateOpenchamberStatus(payload: unknown): SyncEvent | null {
  const parsed = openchamberStatusSchema.safeParse(payload)
  if (!parsed.success) return null
  const { sessionID, sessionId, status, metadata, timestamp, turnStartedAt } = parsed.data.properties
  const id = sessionID ?? sessionId
  if (!id) return null
  const turnStart = status !== "idle" && timestamp !== undefined && turnStartedAt !== undefined
    ? { turnStart: hostTurnStart(turnStartedAt, timestamp) }
    : {}
  if (status === "retry") {
    if (metadata?.attempt === undefined || metadata.message === undefined || metadata.next === undefined) return null
    return {
      type: "session.status",
      properties: { sessionID: id, status: { type: "retry", attempt: metadata.attempt, message: metadata.message, next: metadata.next }, ...turnStart },
    }
  }
  return { type: "session.status", properties: { sessionID: id, status: { type: status }, ...turnStart } }
}

function translateOpenchamberEvent(type: string, payload: unknown): SyncEvent | null {
  switch (type) {
    case "openchamber:session-status":
      return translateOpenchamberStatus(payload)
    case "openchamber:session-archived": {
      const parsed = openchamberArchivedSchema.safeParse(payload)
      if (!parsed.success) return null
      const { sessionID, archivedAt } = parsed.data.properties
      return { type: "session.patched", properties: { sessionID, patch: { time: { archived: archivedAt } } } }
    }
    case "openchamber:session-metadata": {
      const parsed = openchamberMetadataSchema.safeParse(payload)
      if (!parsed.success) return null
      const { sessionID } = parsed.data.properties
      // SAFETY: the server serialises this object from JSON, so every value is a JsonValue.
      const value = parsed.data.properties.metadata as Metadata
      return { type: "session.patched", properties: { sessionID, patch: { metadata: value } } }
    }
    case "openchamber:notification": {
      const parsed = openchamberNotificationSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.notification", properties: parsed.data.properties } : null
    }
    case "openchamber:permission-auto-accept.updated": {
      const parsed = openchamberAutoAcceptSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.permission-auto-accept", properties: parsed.data.properties } : null
    }
    case "openchamber:page-waiting": {
      const parsed = openchamberPageWaitingSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.page-waiting", properties: parsed.data.properties } : null
    }
    case "openchamber:page-settled": {
      const parsed = openchamberPageSettledSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.page-settled", properties: parsed.data.properties } : null
    }
    case "openchamber:session-assist": {
      const parsed = openchamberSessionAssistSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.session-assist", properties: parsed.data.properties } : null
    }
    case "openchamber:permission-auto-accept.left-for-user": {
      const parsed = openchamberLeftForUserSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.permission-left-for-user", properties: parsed.data.properties } : null
    }
    case "openchamber:workflow-run": {
      const parsed = openchamberWorkflowRunSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.workflow-run", properties: parsed.data.properties } : null
    }
    case "openchamber:workflow-run-removed": {
      const parsed = openchamberWorkflowRunRemovedSchema.safeParse(payload)
      return parsed.success ? { type: "openchamber.workflow-run-removed", properties: parsed.data.properties } : null
    }
    default:
      return null
  }
}

function translateWirePayload(payload: unknown, frameDirectory: string | undefined, isStale?: StaleWireEventCheck): Array<{ directory: string; event: SyncEvent }> {
  if (!wireEventSchema.safeParse(payload).success) return []
  // SAFETY: the discriminator and location were validated above; the rest of
  // the shape is the server's generated contract, narrowed per `type` by the
  // translator.
  const event = payload as OpenCodeEvent
  if (isStale?.(event)) return []
  const routed = routeWireEvent(event)
  if (!frameDirectory) return routed
  return routed.map((entry) => (entry.directory === GLOBAL_EVENT_DIRECTORY ? { ...entry, directory: frameDirectory } : entry))
}

type ClassifiedStreamPayload =
  | { kind: "space-stream"; properties: z.infer<typeof openchamberSpaceStreamSchema>["properties"] }
  | { kind: "space-progress"; properties: SpaceProgress }
  | { kind: "space-task-title"; properties: z.infer<typeof openchamberSpaceTaskTitleSchema>["properties"] }
  | { kind: "space-setup"; spaceId: string }
  | { kind: "space-permission-stream"; spaceId: string }
  | { kind: "events"; events: Array<{ directory: string; event: SyncEvent }> }

const NO_EVENTS: ClassifiedStreamPayload = { kind: "events", events: [] }

export function classifyStreamPayload(payload: unknown, frameDirectory: string | undefined, isStale?: StaleWireEventCheck): ClassifiedStreamPayload {
  const typed = payloadTypeSchema.safeParse(payload)
  if (!typed.success) return NO_EVENTS
  const { type } = typed.data
  if (!type.startsWith(OPENCHAMBER_TYPE_PREFIX)) return { kind: "events", events: translateWirePayload(payload, frameDirectory, isStale) }

  switch (type) {
    case "openchamber:space-stream": {
      const parsed = openchamberSpaceStreamSchema.safeParse(payload)
      return parsed.success ? { kind: "space-stream", properties: parsed.data.properties } : NO_EVENTS
    }
    case "openchamber:space-progress": {
      const parsed = openchamberSpaceProgressSchema.safeParse(payload)
      return parsed.success ? { kind: "space-progress", properties: parsed.data.properties } : NO_EVENTS
    }
    case "openchamber:space-task-title.updated": {
      const parsed = openchamberSpaceTaskTitleSchema.safeParse(payload)
      return parsed.success ? { kind: "space-task-title", properties: parsed.data.properties } : NO_EVENTS
    }
    case "openchamber:space-setup": {
      const parsed = openchamberSpaceSetupSchema.safeParse(payload)
      return parsed.success ? { kind: "space-setup", spaceId: parsed.data.properties.spaceId } : NO_EVENTS
    }
    case "openchamber:space-permission-stream": {
      const parsed = openchamberSpacePermissionStreamSchema.safeParse(payload)
      return parsed.success ? { kind: "space-permission-stream", spaceId: parsed.data.properties.spaceId } : NO_EVENTS
    }
  }
  const bridged = translateOpenchamberEvent(type, payload)
  if (bridged) return { kind: "events", events: [{ directory: frameDirectory ?? GLOBAL_EVENT_DIRECTORY, event: bridged }] }
  return { kind: "events", events: translateWirePayload(payload, frameDirectory, isStale) }
}

function buildGlobalEventWsUrl(lastEventId?: string): string {
  let baseUrl = "/api"
  try {
    baseUrl = opencodeClient.getBaseUrl()
  } catch {
    baseUrl = "/api"
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return getRuntimeUrlResolver().websocket(
    `${normalizedBase}global/event/ws`,
    lastEventId && lastEventId.length > 0 ? { lastEventId } : undefined,
  )
}

function openGlobalEventSocket(lastEventId?: string): RelayTunnelWebSocket {
  const url = buildGlobalEventWsUrl(lastEventId)
  return openRuntimeWebSocket(url)
}

type DirectoryQueue = {
  queue: SyncEvent[]
  buffer: SyncEvent[]
  coalesced: Map<string, number>
  timer: ReturnType<typeof setTimeout> | undefined
  last: number
}

type AttemptAbortReason =
  | "pipeline_stopped"
  | `${"ws" | "sse"}_${string}`
  | null

function coalesceKey(event: SyncEvent): string | undefined {
  switch (event.type) {
    case "session.status":
      return `session.status:${event.properties.sessionID}`
    case "session.patched":
      return `session.patched:${event.properties.sessionID}`
    case "message.patched":
      return `message.patched:${event.properties.sessionID}:${event.properties.messageID}`
    case "message.part.delta":
      return `message.part.delta:${event.properties.messageID}:${event.properties.partID}:${event.properties.field}`
    case "vcs.branch.updated":
      return "vcs.branch.updated"
    default:
      return undefined
  }
}

function mergeCoalesced(previous: SyncEvent, next: SyncEvent): SyncEvent {
  if (previous.type === "session.status" && next.type === "session.status") {
    const turnStart = next.properties.turnStart ?? previous.properties.turnStart
    return turnStart && next.properties.status.type !== "idle"
      ? { ...next, properties: { ...next.properties, turnStart } }
      : next
  }
  if (previous.type === "message.part.delta" && next.type === "message.part.delta") {
    return { ...next, properties: { ...next.properties, delta: previous.properties.delta + next.properties.delta } }
  }
  if (previous.type === "session.patched" && next.type === "session.patched") {
    const time = previous.properties.patch.time || next.properties.patch.time
      ? { time: { ...previous.properties.patch.time, ...next.properties.patch.time } }
      : {}
    return { ...next, properties: { ...next.properties, patch: { ...previous.properties.patch, ...next.properties.patch, ...time } } }
  }
  if (previous.type === "message.patched" && next.type === "message.patched") {
    const time = previous.properties.patch.time || next.properties.patch.time
      ? { time: { ...previous.properties.patch.time, ...next.properties.patch.time } }
      : {}
    return { ...next, properties: { ...next.properties, patch: { ...previous.properties.patch, ...next.properties.patch, ...time } } }
  }
  return next
}

export function createEventPipeline(input: EventPipelineInput): EventPipeline {
  const {
    sdk,
    onEvent,
    onEvents,
    onReconnect,
    onDisconnect,
    onTransportSwitch,
    onSpaceStream,
    onSpaceProgress,
    onSpaceTaskTitle,
    onSpaceSetup,
    onSpacePermissionStream,
    onStreamActivity,
    routeDirectory,
    transport = "auto",
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    wsReadyTimeoutMs = DEFAULT_WS_READY_TIMEOUT_MS,
  } = input
  const abort = new AbortController()
  let disconnected = false
  let lastEventId: string | undefined
  let wsFallbackUntil = 0
  let wsEverReady = false
  let wsOpenFailuresSinceReady = 0

  const directories = new Map<string, DirectoryQueue>()
  const isStaleTurnBoundary = createTurnBoundaryOrder(syncDebug.pipeline.staleTurnBoundary)

  const getOrCreateDir = (directory: string): DirectoryQueue => {
    let d = directories.get(directory)
    if (d) return d
    d = {
      queue: [],
      buffer: [],
      coalesced: new Map(),
      timer: undefined,
      last: 0,
    }
    directories.set(directory, d)
    return d
  }

  const flushDir = (directory: string) => {
    const d = directories.get(directory)
    if (!d) return
    if (d.timer) {
      clearTimeout(d.timer)
      d.timer = undefined
    }
    if (d.queue.length === 0) return

    const events = d.queue
    d.queue = d.buffer
    d.buffer = events
    d.queue.length = 0
    d.coalesced.clear()

    d.last = Date.now()
    syncDebug.pipeline.flush(events.length)
    for (let index = 0; index < events.length; index += 1) {
      countSyncPerformance("pipelineDeliveredEvents")
    }
    if (onEvents) {
      onEvents(directory, events)
    } else if (onEvent) {
      for (const payload of events) onEvent(directory, payload)
    }

    d.buffer.length = 0
  }

  const flushAll = () => {
    for (const directory of directories.keys()) {
      flushDir(directory)
    }
  }

  const scheduleDir = (directory: string) => {
    const d = getOrCreateDir(directory)
    if (d.timer) return
    const elapsed = Date.now() - d.last
    const flushFrameMs = Date.now() < backpressureUntil ? BACKPRESSURE_FLUSH_FRAME_MS : FLUSH_FRAME_MS
    d.timer = setTimeout(() => flushDir(directory), Math.max(0, flushFrameMs - elapsed))
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError" ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState !== "visible"

  const extractStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== "object") return undefined
    const direct = (error as { status?: unknown }).status
    if (typeof direct === "number") return direct
    const fromResponse = (error as { response?: { status?: unknown } }).response?.status
    if (typeof fromResponse === "number") return fromResponse
    const fromCause = (error as { cause?: { status?: unknown } }).cause?.status
    if (typeof fromCause === "number") return fromCause
    return undefined
  }

  const isPermanentHttpStatus = (status: number): boolean => {
    if (status < 400 || status >= 500) return false
    if (status === 408 || status === 429) return false
    return true
  }

  const waitForRetry = (ms: number) => new Promise<void>((resolve) => {
    if (ms <= 0 || abort.signal.aborted) {
      resolve()
      return
    }

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (typeof globalThis.window !== "undefined") {
        globalThis.window.removeEventListener("online", onInterrupt)
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityInterrupt)
      }
      abort.signal.removeEventListener("abort", onInterrupt)
      unsubscribeAuthSession()
    }
    const onInterrupt = () => {
      cleanup()
      resolve()
    }
    const onVisibilityInterrupt = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        onInterrupt()
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onInterrupt, ms)
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.addEventListener("online", onInterrupt, { once: true })
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityInterrupt)
    }
    abort.signal.addEventListener("abort", onInterrupt, { once: true })
    const unsubscribeAuthSession = useAuthSessionStore.subscribe((store, previous) => {
      if (store.state === "ok" && previous.state !== "ok") onInterrupt()
    })
  })

  const computeRetryDelay = (failures: number): number => {
    if (failures <= 0) return 0
    if (isServerOffline()) return RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS
    const cap = isHidden() ? RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS : RETRY_BACKOFF_CAP_VISIBLE_MS
    const exponent = Math.min(failures - 1, RETRY_BACKOFF_MAX_EXPONENT)
    return Math.min(cap, RETRY_BACKOFF_BASE_MS * 2 ** exponent)
  }

  let streamErrorLogged = false
  let attempt: AbortController | undefined
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let activeTransport: "ws" | "sse" = transport === "ws" ? "ws" : "sse"
  let attemptAbortReason: AttemptAbortReason = null
  let consecutiveFailures = 0
  let backpressureUntil = 0

  const notifyDisconnected = (reason: string) => {
    if (disconnected) {
      return
    }
    disconnected = true
    onDisconnect?.(reason)
  }

  const markConnected = (replayReset = false, replayed = false) => {
    disconnected = false
    consecutiveFailures = 0
    onReconnect?.({ replayReset, replayed })
  }

  const enqueueEvent = (directory: string, event: SyncEvent) => {
    countSyncPerformance("pipelineRawEvents")
    const routedDirectory = routeDirectory?.(directory, event) || directory
    const d = getOrCreateDir(routedDirectory)

    if (event.type === "message.part.updated") {
      const deltaPrefix = `message.part.delta:${event.properties.part.messageID}:${event.properties.part.id}:`
      for (const key of d.coalesced.keys()) {
        if (key.startsWith(deltaPrefix)) d.coalesced.delete(key)
      }
    }

    if (
      event.type === "session.idle"
      || event.type === "session.error"
      || event.type === "session.created"
      || event.type === "session.deleted"
    ) {
      const sessionID = syncEventSessionID(event)
      if (sessionID) {
        d.coalesced.delete(`session.status:${sessionID}`)
        if (event.type === "session.created" || event.type === "session.deleted") {
          d.coalesced.delete(`session.patched:${sessionID}`)
        }
      }
    }

    const key = coalesceKey(event)
    if (key) {
      const index = d.coalesced.get(key)
      if (index !== undefined) {
        d.queue[index] = mergeCoalesced(d.queue[index], event)
        countSyncPerformance("pipelineCoalescedEvents")
        syncDebug.pipeline.coalesced(event.type, key)
        return
      }
      d.coalesced.set(key, d.queue.length)
    }

    d.queue.push(event)
    scheduleDir(routedDirectory)
  }

  const enqueuePayload = (payload: unknown, frameDirectory: string | undefined) => {
    const classified = classifyStreamPayload(payload, frameDirectory, isStaleTurnBoundary)
    if (classified.kind === "space-stream") {
      onSpaceStream?.(classified.properties)
      return
    }
    if (classified.kind === "space-progress") {
      onSpaceProgress?.(classified.properties)
      return
    }
    if (classified.kind === "space-task-title") {
      onSpaceTaskTitle?.(classified.properties.spaceId, classified.properties.taskTitle)
      return
    }
    if (classified.kind === "space-setup") {
      onSpaceSetup?.(classified.spaceId)
      return
    }
    if (classified.kind === "space-permission-stream") {
      onSpacePermissionStream?.(classified.spaceId)
      return
    }
    for (const { directory, event } of classified.events) {
      enqueueEvent(directory, event)
    }
  }

  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attemptAbortReason = `${activeTransport}_heartbeat_timeout`
      attempt?.abort()
    }, heartbeatTimeoutMs)
  }

  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const noteStreamActivity = () => {
    resetHeartbeat()
    onStreamActivity?.()
  }

  const runSseAttempt = async (signal: AbortSignal) => {
    const events = sdk.event.subscribe({ signal, onActivity: noteStreamActivity })

    let connected = false
    let yielded = Date.now()
    resetHeartbeat()

    for await (const event of events) {
      noteStreamActivity()
      streamErrorLogged = false
      if (!connected) {
        connected = true
        markConnected()
      }

      enqueuePayload(event, undefined)

      if (Date.now() - yielded < STREAM_YIELD_MS) continue
      yielded = Date.now()
      await wait(0)
    }
  }

  const wsOpenFailureFallsBack = (): boolean => {
    if (!wsEverReady) return true
    if (isServerOffline()) return false
    wsOpenFailuresSinceReady += 1
    return wsOpenFailuresSinceReady >= WS_PROVEN_OPEN_FAILURES_BEFORE_FALLBACK
  }

  const runWsAttempt = async (signal: AbortSignal) => {
    try {
      await refreshRuntimeUrlAuthToken()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error("Message stream WebSocket auth token unavailable")
      if (transport === "auto" && wsOpenFailureFallsBack()) {
        wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
        ;(wrapped as Error & { code?: string }).code = "WS_FALLBACK"
      }
      ;(wrapped as Error & { reason?: string }).reason = "ws_auth_token_unavailable"
      throw wrapped
    }
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let opened = false
      let readyAt = 0
      const socket: RelayTunnelWebSocket = openGlobalEventSocket(lastEventId)
      let openFailureFallsBack: boolean | undefined
      const setFallbackCode = (error: Error, force = false) => {
        if ((!force && opened) || transport !== "auto") return
        if (!force) {
          openFailureFallsBack ??= wsOpenFailureFallsBack()
          if (!openFailureFallsBack) return
        }
        wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
        ;(error as Error & { code?: string }).code = "WS_FALLBACK"
      }

      let readyTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        readyTimer = undefined
        const error = new Error("Message stream WebSocket ready timeout")
        setFallbackCode(error)
        settleReject(error)
        try {
          socket.close()
        } catch {
          // ignore
        }
      }, wsReadyTimeoutMs)

      const cleanup = () => {
        if (readyTimer) {
          clearTimeout(readyTimer)
          readyTimer = undefined
        }
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }

      const settleResolve = () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        resolve()
      }

      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        reject(error)
      }

      const handleAbort = () => {
        try {
          socket.close()
        } catch {
          // ignore close failures during abort
        }
        settleResolve()
      }

      signal.addEventListener("abort", handleAbort, { once: true })

      socket.onopen = () => {
        // Don't clear streamErrorLogged here. If the socket immediately closes
        // before sending the ready frame, clearing would cause log spam.
      }

      socket.onmessage = (messageEvent) => {
        noteStreamActivity()
        streamErrorLogged = false

        let raw: unknown
        try {
          raw = JSON.parse(String(messageEvent.data))
        } catch (error) {
          console.warn("[event-pipeline] Failed to parse WS frame", error)
          return
        }
        const parsed = wsFrameSchema.safeParse(raw)
        if (!parsed.success) return
        const frame = parsed.data

        if (frame.type === "ready") {
          if (frame.replayReset === true) lastEventId = undefined
          if (frame.replayed !== true && frame.cursor) lastEventId = frame.cursor
          opened = true
          wsEverReady = true
          wsOpenFailuresSinceReady = 0
          readyAt = Date.now()
          if (readyTimer) {
            clearTimeout(readyTimer)
            readyTimer = undefined
          }
          streamErrorLogged = false
          markConnected(frame.replayReset === true, frame.replayed === true)
          return
        }

        if (frame.type === "error") {
          const error = new Error(frame.message || "Message stream WebSocket error")
          ;(error as Error & { reason?: string }).reason = `ws_error_frame:${frame.message || "unknown"}`
          setFallbackCode(error)
          settleReject(error)
          try {
            socket.close()
          } catch {
            // ignore
          }
          return
        }

        if (frame.type === "backpressure") {
          backpressureUntil = Date.now() + BACKPRESSURE_MODE_MS
          return
        }

        if (frame.eventId) {
          lastEventId = frame.eventId
        }
        enqueuePayload(frame.payload, frame.directory)
      }

      socket.onerror = () => {
        void 0
      }

      socket.onclose = (event) => {
        if (signal.aborted) {
          settleResolve()
          return
        }

        const error = new Error("Global message stream WebSocket closed")
        ;(error as Error & { reason?: string }).reason = opened
          ? `ws_closed:code=${event?.code ?? "?"}`
          : "ws_closed_before_ready"

        if (!opened) {
          clearRuntimeUrlAuthToken()
        }

        const livedMs = readyAt > 0 ? Date.now() - readyAt : 0
        const unstableAfterReady = opened && livedMs > 0 && livedMs < 2_000
        setFallbackCode(error, unstableAfterReady)
        settleReject(error)
      }
    })
  }

  const resolveTransport = (): "ws" | "sse" => {
    if (typeof WebSocket !== "function" || isVSCodeRuntime()) {
      return "sse"
    }
    if (transport === "ws") {
      return "ws"
    }
    if (transport === "sse") {
      return "sse"
    }
    return wsFallbackUntil > Date.now() ? "sse" : "ws"
  }

  void (async () => {
    while (!abort.signal.aborted) {
      await waitForAuthSession(abort.signal)
      if (abort.signal.aborted) return
      attempt = new AbortController()
      lastEventAt = Date.now()
      attemptAbortReason = null
      let retryDelayMs = reconnectDelayMs
      const currentTransport = resolveTransport()
      activeTransport = currentTransport
      const onAbort = () => {
        attemptAbortReason = "pipeline_stopped"
        attempt?.abort()
      }
      abort.signal.addEventListener("abort", onAbort)

      try {
        if (currentTransport === "ws") {
          await runWsAttempt(attempt.signal)
        } else {
          await runSseAttempt(attempt.signal)
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
        if (currentTransport === "ws" && code === "WS_FALLBACK") {
          retryDelayMs = 0
          onTransportSwitch?.()
        } else if (!isAbortError(error)) {
          consecutiveFailures += 1
          if (!streamErrorLogged) {
            streamErrorLogged = true
            console.error("[event-pipeline] stream failed", error)
          }
          const taggedReason = typeof error === "object" && error !== null
            ? (error as { reason?: unknown }).reason
            : undefined
          const message = typeof error === "object" && error !== null
            ? (error as { message?: unknown }).message
            : undefined
          const reason = typeof taggedReason === "string" && taggedReason.length > 0
            ? taggedReason
            : typeof message === "string" && message.length > 0
              ? `${currentTransport}_error:${message.slice(0, 80)}`
              : `${currentTransport}_error:unknown`
          notifyDisconnected(reason)

          const status = extractStatus(error)
          if (status !== undefined && isPermanentHttpStatus(status)) {
            retryDelayMs = RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS
          } else {
            retryDelayMs = computeRetryDelay(consecutiveFailures)
          }
        }
      } finally {
        abort.signal.removeEventListener("abort", onAbort)
        attempt = undefined
        clearHeartbeat()
      }

      if (abort.signal.aborted) return
      if (attemptAbortReason && attemptAbortReason !== "pipeline_stopped") {
        notifyDisconnected(attemptAbortReason)
        retryDelayMs = 0
        attemptAbortReason = null
      }
      if (retryDelayMs > 0) {
        await waitForRetry(retryDelayMs)
      }
    }
  })().finally(flushAll)

  const onVisibility = () => {
    if (typeof document === "undefined") return
    if (document.visibilityState !== "visible") return
    if (Date.now() - lastEventAt < heartbeatTimeoutMs) return
    attempt?.abort()
  }

  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    attempt?.abort()
  }

  const onSystemResume = () => {
    attemptAbortReason = `${activeTransport}_system_resume`
    attempt?.abort()
  }

  const onOnline = () => {
    if (!disconnected) return
    attempt?.abort()
  }

  const onOffline = () => {
    attempt?.abort()
  }

  const reconnect = (reason = "manual") => {
    attemptAbortReason = `${activeTransport}_${reason}`
    attempt?.abort()
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
  }

  if (typeof globalThis.window !== "undefined") {
    globalThis.window.addEventListener("openchamber:system-resume", onSystemResume)
    globalThis.window.addEventListener("online", onOnline)
    globalThis.window.addEventListener("offline", onOffline)
  }

  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
    }
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.removeEventListener("openchamber:system-resume", onSystemResume)
      globalThis.window.removeEventListener("online", onOnline)
      globalThis.window.removeEventListener("offline", onOffline)
    }
    abort.abort()
    flushAll()
  }

  return { cleanup, reconnect }
}
