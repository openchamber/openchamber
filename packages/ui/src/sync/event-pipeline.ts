/**
 * Event Pipeline — transport connection, translation, coalescing, and batched flush.
 *
 * Wire events (OpenCode v2 `/api/event`, or the OpenChamber server's WebSocket
 * bridge of that stream) are translated into `SyncEvent`s here and coalesced
 * per directory before the reducer sees them. This module must not make
 * state-dependent decisions about event validity: deciding whether a delta is
 * already represented by a full part snapshot belongs in the reducer.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvents })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import { opencodeClient } from "@/lib/opencode/client"
import { GLOBAL_EVENT_DIRECTORY, routeWireEvent, syncEventSessionID, type SyncEvent } from "@/lib/opencode/events"
import type { Metadata } from "@/lib/opencode/model"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { type RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { openRuntimeWebSocket } from "@/lib/relay/runtime-socket"
import { isVSCodeRuntime } from "@/lib/desktop"
import { syncDebug } from "./debug"
import { countSyncPerformance } from "./performance-diagnostics"

// Paces a sustained event stream only: the first event after a quiet spell is
// flushed at once, so a lone permission or status event is not delayed. Every
// flush publishes the directory store and re-renders the streaming message,
// while streamed text is shown at most every 100ms, so flushing faster than
// that bought renders nobody sees. Measured at 300 characters per second,
// 33ms cost six more points of renderer CPU for the same visible output.
const FLUSH_FRAME_MS = 100
const BACKPRESSURE_FLUSH_FRAME_MS = 200
const BACKPRESSURE_MODE_MS = 10_000
const STREAM_YIELD_MS = 8
const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const WS_FALLBACK_WINDOW_MS = 60_000
const DEFAULT_WS_READY_TIMEOUT_MS = 2_000
// Retry pacing. Visible+online tabs probe quickly so the user sees connection
// recovery in under a second of real outage; hidden/offline tabs back off
// further so a backgrounded PWA on a flaky link doesn't burn battery probing
// a dead network every few seconds. The browser would throttle hidden-tab
// timers anyway, but this keeps the intent explicit and shrinks server load
// from idle tabs.
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
  /** Called after stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: (details: { replayReset: boolean }) => void
  /** Called when the stream disconnects (heartbeat timeout, network error, or transport failure). */
  onDisconnect?: (reason: string) => void
  /** Called when transport switches (e.g. WS timeout → SSE fallback) without actual disconnection. */
  onTransportSwitch?: () => void
  /**
   * Called when the host announces that an isolated space's own event connection came or
   * went; after a gap that one space is re-read. `wasReady` says whether the space's stream
   * had been connected before.
   */
  onSpaceStream?: (details: { spaceId: string; status: "connected" | "disconnected"; wasReady: boolean }) => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
} & EventPipelineDelivery

export type EventPipeline = {
  cleanup: () => void
  reconnect: (reason?: string) => void
}

// Frames the OpenChamber server sends on `/api/global/event/ws`. `payload` is
// the wire event as OpenCode published it; the server adds replay metadata.
const wsFrameSchema = z.object({
  type: z.enum(["ready", "event", "error", "backpressure"]),
  replayReset: z.boolean().optional(),
  payload: z.unknown().optional(),
  eventId: z.string().optional(),
  directory: z.string().optional(),
  message: z.string().optional(),
})

// OpenChamber's own session-status bridge rides the same stream. It predates
// OpenCode's `session.status` and carries the status in `properties`.
const openchamberStatusSchema = z.object({
  type: z.literal("openchamber:session-status"),
  properties: z.object({
    sessionID: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    status: z.enum(["idle", "busy", "retry"]),
    metadata: z.object({ attempt: z.number(), message: z.string(), next: z.number() }).partial().optional(),
  }),
})

// OpenChamber owns archive state; its server announces changes on the stream.
const openchamberArchivedSchema = z.object({
  type: z.literal("openchamber:session-archived"),
  properties: z.object({ sessionID: z.string().min(1), archivedAt: z.number().nullable() }),
})

const openchamberMetadataSchema = z.object({
  type: z.literal("openchamber:session-metadata"),
  properties: z.object({ sessionID: z.string().min(1), metadata: z.record(z.string(), z.unknown()) }),
})

const openchamberNotificationSchema = z.object({
  type: z.literal("openchamber:notification"),
  properties: z
    .object({
      kind: z.string(),
      sessionId: z.string(),
      directory: z.string(),
      title: z.string(),
      body: z.string(),
      tag: z.string(),
      requireHidden: z.boolean(),
      desktopNotificationDelivered: z.boolean(),
      desktopStdoutActive: z.boolean(),
    })
    .partial(),
})

// The host's announcement of an isolated space's event connection. It is not an event of any
// session, so it never enters a directory queue; the pipeline hands it to its owner.
const openchamberSpaceStreamSchema = z.object({
  type: z.literal("openchamber:space-stream"),
  properties: z.object({
    spaceId: z.string().regex(/^[0-9a-f]{12}$/),
    status: z.enum(["connected", "disconnected"]),
    wasReady: z.boolean(),
  }),
})

const openchamberAutoAcceptSchema = z.object({
  type: z.literal("openchamber:permission-auto-accept.updated"),
  properties: z.object({ sessions: z.record(z.string(), z.boolean()), revision: z.number().optional() }),
})

// The wire event contract is generated from the server; the stream is trusted
// once its shape matches. Only the discriminator and location are checked here
// because the translator narrows on `type` for everything else.
const wireEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  location: z.object({ directory: z.string() }).partial().optional(),
})

function translateOpenchamberArchived(payload: unknown): SyncEvent | null {
  const parsed = openchamberArchivedSchema.safeParse(payload)
  if (!parsed.success) return null
  const { sessionID, archivedAt } = parsed.data.properties
  return { type: "session.patched", properties: { sessionID, patch: { time: { archived: archivedAt } } } }
}

function translateOpenchamberNative(payload: unknown): SyncEvent | null {
  const metadata = openchamberMetadataSchema.safeParse(payload)
  if (metadata.success) {
    const { sessionID } = metadata.data.properties
    // SAFETY: the server serialises this object from JSON, so every value is a JsonValue.
    const value = metadata.data.properties.metadata as Metadata
    return { type: "session.patched", properties: { sessionID, patch: { metadata: value } } }
  }
  const notification = openchamberNotificationSchema.safeParse(payload)
  if (notification.success) return { type: "openchamber.notification", properties: notification.data.properties }
  const autoAccept = openchamberAutoAcceptSchema.safeParse(payload)
  if (autoAccept.success) return { type: "openchamber.permission-auto-accept", properties: autoAccept.data.properties }
  return null
}

function translateOpenchamberStatus(payload: unknown): SyncEvent | null {
  const parsed = openchamberStatusSchema.safeParse(payload)
  if (!parsed.success) return null
  const { sessionID, sessionId, status, metadata } = parsed.data.properties
  const id = sessionID ?? sessionId
  if (!id) return null
  if (status === "retry") {
    if (metadata?.attempt === undefined || metadata.message === undefined || metadata.next === undefined) return null
    return {
      type: "session.status",
      properties: { sessionID: id, status: { type: "retry", attempt: metadata.attempt, message: metadata.message, next: metadata.next } },
    }
  }
  return { type: "session.status", properties: { sessionID: id, status: { type: status } } }
}

/**
 * Turns one raw stream payload into routed sync events. `frameDirectory` is
 * the directory the server bridge attached, used when the event itself does
 * not name a location.
 */
function translatePayload(payload: unknown, frameDirectory: string | undefined): Array<{ directory: string; event: SyncEvent }> {
  const bridged = translateOpenchamberStatus(payload) ?? translateOpenchamberArchived(payload) ?? translateOpenchamberNative(payload)
  if (bridged) return [{ directory: frameDirectory ?? GLOBAL_EVENT_DIRECTORY, event: bridged }]
  if (!wireEventSchema.safeParse(payload).success) return []
  // SAFETY: the discriminator and location were validated above; the rest of
  // the shape is the server's generated contract, narrowed per `type` by the
  // translator.
  const routed = routeWireEvent(payload as OpenCodeEvent)
  if (!frameDirectory) return routed
  return routed.map((entry) => (entry.directory === GLOBAL_EVENT_DIRECTORY ? { ...entry, directory: frameDirectory } : entry))
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

// In relay mode the global-event WebSocket rides the E2EE tunnel instead of a
// native network socket. The resolver still builds the authenticated URL (it
// carries the oc_url_token the host replays to the loopback origin); we hand
// its path+query to the tunnel, which returns a socket-like with the exact
// on* handler surface this pipeline uses. Direct-URL runtimes keep the native
// WebSocket path, wrapped to the same shape so the caller holds one type.
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

/** Key under which repeated events for the same entity collapse into one. */
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

/** Merges a later event into the queued one it coalesces with. */
function mergeCoalesced(previous: SyncEvent, next: SyncEvent): SyncEvent {
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

  const directories = new Map<string, DirectoryQueue>()

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

  const isOffline = (): boolean =>
    typeof navigator === "object" && navigator !== null && navigator.onLine === false

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState !== "visible"

  // Extract an HTTP status code from anywhere it might be hiding on the
  // error object. Our client normaliser stashes it on `.status`; raw
  // fetch failures may carry `.response.status`.
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

  // 4xx errors don't recover from blind retry — wrong path, expired auth,
  // bad request body. Keep retrying anyway (a remote reconfigure or reauth
  // can fix the underlying problem) but at the long cap so we're not
  // hammering the server at 5s intervals indefinitely. 408 (timeout) and
  // 429 (rate limit) are retryable in spirit — let them through to the
  // normal exponential path.
  const isPermanentHttpStatus = (status: number): boolean => {
    if (status < 400 || status >= 500) return false
    if (status === 408 || status === 429) return false
    return true
  }

  /**
   * Wait between reconnect attempts. Resolves early when:
   *   - the browser fires `online` (network came back — probe immediately),
   *   - the tab becomes visible (user came back — probe immediately),
   *   - the pipeline is being torn down (cleanup aborts).
   * Otherwise resolves after `ms` like a plain timer.
   */
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
  })

  const computeRetryDelay = (failures: number): number => {
    if (failures <= 0) return 0
    // Offline: don't spin probing a dead network. Use the long cap and rely on
    // waitForRetry to resolve early when the `online` event fires. The cap is
    // also a fallback for browsers that miss `online`.
    if (isOffline()) return RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS
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

  const markConnected = (replayReset = false) => {
    disconnected = false
    consecutiveFailures = 0
    // Fire onReconnect on every successful connect — including the very
    // first one. Consumer state (isConnected) starts at false and needs
    // to be flipped positively; without this the send button throws
    // "Connection lost" until something else (HTTP health check) happens
    // to race a setState({isConnected: true}) through.
    onReconnect?.({ replayReset })
  }

  const enqueueEvent = (directory: string, event: SyncEvent) => {
    countSyncPerformance("pipelineRawEvents")
    const routedDirectory = routeDirectory?.(directory, event) || directory
    const d = getOrCreateDir(routedDirectory)

    // A full part snapshot is a coalescing barrier for that part's deltas:
    // drop its pending delta coalescing keys so a delta arriving after the
    // snapshot starts a fresh queue entry instead of merging into a delta
    // queued before the snapshot, which the snapshot would then overwrite and
    // drop the later delta's text. The already-queued delta event stays.
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
    const spaceStream = openchamberSpaceStreamSchema.safeParse(payload)
    if (spaceStream.success) {
      onSpaceStream?.(spaceStream.data.properties)
      return
    }
    for (const { directory, event } of translatePayload(payload, frameDirectory)) {
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

  const runSseAttempt = async (signal: AbortSignal) => {
    // Keepalive comments carry no event but prove the socket is alive.
    const events = sdk.event.subscribe({ signal, onActivity: resetHeartbeat })

    let connected = false
    let yielded = Date.now()
    resetHeartbeat()

    for await (const event of events) {
      resetHeartbeat()
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

  const runWsAttempt = async (signal: AbortSignal) => {
    // A WebSocket upgrade can't carry an Authorization header, so it
    // authenticates purely via the oc_url_token query param. The sync token
    // getter returns "" while the token is unminted or inside its expiry skew
    // window, which would open the socket WITHOUT credentials — the server then
    // rejects it ("HTTP Authentication failed; no valid credentials available")
    // and the resulting reconnect storm churns the sync store (transient
    // status-missing → idle flicker). Mint/await a valid token BEFORE
    // connecting. (SSE avoids this: the SDK fetch sends the bearer header.)
    try {
      await refreshRuntimeUrlAuthToken()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error("Message stream WebSocket auth token unavailable")
      if (transport === "auto") {
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
      const setFallbackCode = (error: Error, force = false) => {
        if ((force || !opened) && transport === "auto") {
          wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
          ;(error as Error & { code?: string }).code = "WS_FALLBACK"
        }
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
        resetHeartbeat()
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
          // The retained suffix no longer covers our cursor. The normal
          // reconnect callback repairs authoritative state; retire that cursor.
          if (frame.replayReset === true) lastEventId = undefined
          opened = true
          readyAt = Date.now()
          if (readyTimer) {
            clearTimeout(readyTimer)
            readyTimer = undefined
          }
          streamErrorLogged = false
          markConnected(frame.replayReset === true)
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

        // Closed before the socket ever opened → the server rejected the
        // upgrade, typically an auth failure on the oc_url_token. Drop the
        // cached token so the next attempt mints a fresh one instead of
        // replaying a token the server won't accept (which would loop).
        if (!opened) {
          clearRuntimeUrlAuthToken()
        }

        // If the WS stream connects (ready) but then drops quickly, prefer SSE for a while.
        // This avoids tight reconnect loops with repeated console spam.
        const livedMs = readyAt > 0 ? Date.now() - readyAt : 0
        const unstableAfterReady = opened && livedMs > 0 && livedMs < 2_000
        setFallbackCode(error, unstableAfterReady)
        settleReject(error)
      }
    })
  }

  const resolveTransport = (): "ws" | "sse" => {
    // The VS Code webview bridges only HTTP/SSE; there is no WebSocket bridge.
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
          // Transport switch (WS → SSE fallback), not a real disconnection.
          // The consumer still gets a hook so it can resync authoritative
          // state; real networks can lose/buffer events around transport flips.
          onTransportSwitch?.()
        } else if (!isAbortError(error)) {
          consecutiveFailures += 1
          if (!streamErrorLogged) {
            streamErrorLogged = true
            console.error("[event-pipeline] stream failed", error)
          }
          // Notify consumer that the stream has disconnected, so it can
          // update connection state (e.g. set isConnected = false).
          // Guard: only fire once per disconnection cycle to avoid repeated
          // setState calls on every failed retry attempt.
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

          // Exponential backoff so a hard-down server / dead network doesn't
          // spin the event loop. Caps lower (5s) when the user is foreground
          // and the browser thinks it's online; caps higher (60s) when hidden
          // or offline so a backgrounded PWA on a flaky link doesn't burn
          // battery. waitForRetry below resolves early on `online` or
          // visibility-visible so recovery is still under a second.
          //
          // Override for permanent 4xx errors: stuck-path / bad-auth scenarios
          // won't recover from blind retry. Use the long cap immediately so
          // the client doesn't pound the server log at 12 reqs/min. The
          // waitForRetry interrupters still apply, so a fix on the other end
          // followed by `online`/visibility recovery probes promptly.
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

  // OS wake-from-sleep (Electron powerMonitor.resume). The SSE connection
  // is almost certainly dead after sleep — abort immediately so the
  // reconnect loop fires on the next tick with retryDelayMs = 0.
  const onSystemResume = () => {
    attemptAbortReason = `${activeTransport}_system_resume`
    attempt?.abort()
  }

  // Browser told us the network is back. If we're already in a disconnected
  // cycle, abort the (stale) attempt and let the loop probe immediately;
  // waitForRetry also resolves early on `online`, so any inter-attempt sleep
  // ends now. Guard on `disconnected` so a spurious `online` from the browser
  // doesn't disrupt a healthy connection.
  const onOnline = () => {
    if (!disconnected) return
    attempt?.abort()
  }

  // Browser told us we're offline. Abort the current attempt — its socket /
  // fetch will throw soon anyway, this just stops sooner. computeRetryDelay
  // then returns the long cap so we wait for `online` instead of hammering
  // a dead network.
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

  // Use globalThis (not window) for the system-resume listener so that
  // test environments can replace globalThis.window with a stub.
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
