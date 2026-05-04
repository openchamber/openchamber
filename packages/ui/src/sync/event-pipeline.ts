/**
 * Event Pipeline — transport connection, event coalescing, and batched flush.
 *
 * This module must not make state-dependent decisions about event validity.
 * For example, deciding whether a delta is already represented by a full part
 * snapshot belongs in the reducer, which has access to the current state.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvent })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { syncDebug } from "./debug"

export type QueuedEvent = {
  directory: string
  payload: Event
}

export type FlushHandler = (events: QueuedEvent[]) => void

const FLUSH_FRAME_MS = 33
const BACKPRESSURE_FLUSH_FRAME_MS = 200
const BACKPRESSURE_MODE_MS = 10_000
const STREAM_YIELD_MS = 8
const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const WS_FALLBACK_WINDOW_MS = 60_000
const DEFAULT_WS_READY_TIMEOUT_MS = 2_000
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//

export type EventPipelineInput = {
  sdk: OpencodeClient
  onEvent: (directory: string, payload: Event) => void
  routeDirectory?: (directory: string, payload: Event) => string
  /** Called after stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
  /** Called when the stream disconnects (heartbeat timeout, network error, or transport failure). */
  onDisconnect?: (reason: string) => void
  /** Called when transport switches (e.g. WS timeout → SSE fallback) without actual disconnection. */
  onTransportSwitch?: () => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
}

type MessageStreamWsFrame = {
  type: "ready" | "event" | "error" | "backpressure"
  payload?: unknown
  eventId?: string
  directory?: string
  message?: string
  scope?: "global" | "directory"
}

const normalizeEventType = (payload: Event): Event => {
  const type = (payload as { type?: unknown }).type
  if (typeof type !== "string") {
    return payload
  }

  const match = /^(.*)\.(\d+)$/.exec(type)
  if (!match || !match[1]) {
    return payload
  }

  return {
    ...payload,
    type: match[1] as Event["type"],
  } as unknown as Event
}

function resolveEventDirectory(event: unknown, payload: Event): string {
  const directDirectory =
    typeof event === "object" && event !== null && typeof (event as { directory?: unknown }).directory === "string"
      ? (event as { directory: string }).directory
      : null

  if (directDirectory && directDirectory.length > 0) {
    return directDirectory
  }

  const properties =
    typeof payload.properties === "object" && payload.properties !== null
      ? (payload.properties as Record<string, unknown>)
      : null
  const propertyDirectory = typeof properties?.directory === "string" ? properties.directory : null

  return propertyDirectory && propertyDirectory.length > 0 ? propertyDirectory : "global"
}

function resolveEventPayload(payload: unknown): Event | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const record = payload as { type?: unknown; payload?: unknown }
  if (typeof record.type === "string") {
    return payload as Event
  }

  if (record.payload && typeof record.payload === "object" && typeof (record.payload as { type?: unknown }).type === "string") {
    return record.payload as Event
  }

  return null
}

function resolveAbsoluteUrl(candidate: string): string {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api"
  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized
  }

  if (typeof window === "undefined") {
    return normalized
  }

  const baseReference = window.location?.href || window.location?.origin
  if (!baseReference) {
    return normalized
  }

  return new URL(normalized, baseReference).toString()
}

function toWebSocketUrl(candidate: string): string {
  const url = new URL(resolveAbsoluteUrl(candidate))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function buildGlobalEventWsUrl(lastEventId?: string): string {
  // Resolve from the current runtime origin.
  // The global event endpoint is served by the OpenChamber web server at `/api/*`
  // in all runtimes (web, desktop, vscode), even when the OpenCode base URL differs.
  const httpUrl = new URL(resolveAbsoluteUrl("/api/global/event/ws"))
  if (lastEventId && lastEventId.length > 0) {
    httpUrl.searchParams.set("lastEventId", lastEventId)
  }
  return toWebSocketUrl(httpUrl.toString())
}

type DirectoryQueue = {
  queue: Event[]
  buffer: Event[]
  coalesced: Map<string, number>
  timer: ReturnType<typeof setTimeout> | undefined
  last: number
}

type AttemptAbortReason =
  | "pipeline_stopped"
  | "ws_heartbeat_timeout"
  | "sse_heartbeat_timeout"
  | "ws_system_resume"
  | "sse_system_resume"
  | null

export function createEventPipeline(input: EventPipelineInput) {
  const {
    sdk,
    onEvent,
    onReconnect,
    onDisconnect,
    onTransportSwitch,
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

  const key = (payload: Event): string | undefined => {
    if (payload.type === "session.status") {
      const props = payload.properties as { sessionID: string }
      return `session.status:${props.sessionID}`
    }
    if (payload.type === "lsp.updated") {
      return "lsp.updated"
    }
    if (payload.type === "message.part.updated") {
      const part = (payload.properties as { part: { messageID: string; id: string } }).part
      return `message.part.updated:${part.messageID}:${part.id}`
    }
    if (payload.type === "message.part.delta") {
      const props = payload.properties as { messageID: string; partID: string; field: string }
      return `message.part.delta:${props.messageID}:${props.partID}:${props.field}`
    }
    return undefined
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
    for (const payload of events) {
      onEvent(directory, payload)
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

  const markConnected = () => {
    disconnected = false
    consecutiveFailures = 0
    // Fire onReconnect on every successful connect — including the very
    // first one. Consumer state (isConnected) starts at false and needs
    // to be flipped positively; without this the send button throws
    // "Connection lost" until something else (HTTP health check) happens
    // to race a setState({isConnected: true}) through.
    onReconnect?.()
  }

  const enqueueEvent = (directory: string, payload: Event) => {
    const normalizedPayload = normalizeEventType(payload)
    const routedDirectory = routeDirectory?.(directory, normalizedPayload) || directory
    const d = getOrCreateDir(routedDirectory)
    const k = key(normalizedPayload)
    if (k) {
      const i = d.coalesced.get(k)
      if (i !== undefined) {
        if (normalizedPayload.type === "message.part.delta") {
          const prev = d.queue[i] as unknown as { properties: { delta: string } }
          const inc = normalizedPayload.properties as { delta: string }
          d.queue[i] = {
            ...normalizedPayload,
            properties: {
              ...(normalizedPayload.properties as object),
              delta: prev.properties.delta + inc.delta,
            },
          } as unknown as Event
        } else {
          d.queue[i] = normalizedPayload
        }
        syncDebug.pipeline.coalesced(normalizedPayload.type, k)
        return
      }
      d.coalesced.set(k, d.queue.length)
    }

    d.queue.push(normalizedPayload)
    scheduleDir(routedDirectory)
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
    const events = await sdk.global.event({
      signal,
      ...(lastEventId && lastEventId.length > 0 ? { headers: { "Last-Event-ID": lastEventId } } : {}),
      onSseEvent: (event: { id?: unknown }) => {
        resetHeartbeat()
        if (typeof event.id === "string" && event.id.length > 0) {
          lastEventId = event.id
        }
      },
      onSseError: (error: unknown) => {
        if (isAbortError(error)) return
        if (streamErrorLogged) return
        streamErrorLogged = true
        console.error("[event-pipeline] SSE stream error", error)
      },
    })

    markConnected()

    let yielded = Date.now()
    resetHeartbeat()

    for await (const event of events.stream) {
      resetHeartbeat()
      streamErrorLogged = false

      const payload = resolveEventPayload((event as { payload?: Event }).payload ?? event)
      if (!payload) {
        continue
      }
      const directory = resolveEventDirectory(event, payload)
      enqueueEvent(directory, payload)

      if (Date.now() - yielded < STREAM_YIELD_MS) continue
      yielded = Date.now()
      await wait(0)
    }
  }

  const runWsAttempt = async (signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let opened = false
      let readyAt = 0
      const socket = new WebSocket(buildGlobalEventWsUrl(lastEventId))
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

        let frame: MessageStreamWsFrame | null = null
        try {
          frame = JSON.parse(String(messageEvent.data)) as MessageStreamWsFrame
        } catch (error) {
          console.warn("[event-pipeline] Failed to parse WS frame", error)
          return
        }

        if (!frame || typeof frame.type !== "string") {
          return
        }

        if (frame.type === "ready") {
          opened = true
          readyAt = Date.now()
          if (readyTimer) {
            clearTimeout(readyTimer)
            readyTimer = undefined
          }
          streamErrorLogged = false
          markConnected()
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

        if (frame.type !== "event") {
          return
        }

        const payload = resolveEventPayload(frame.payload)
        if (!payload) {
          return
        }

        if (typeof frame.eventId === "string" && frame.eventId.length > 0) {
          lastEventId = frame.eventId
        }

        const directory = resolveEventDirectory(
          { directory: frame.directory, payload },
          payload,
        )
        enqueueEvent(directory, payload)
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
    if (typeof WebSocket !== "function") {
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
          // No events were lost — the next attempt will use SSE and carry
          // lastEventId for gapless replay. Notify consumer so it can set
          // isConnected, but do NOT treat this as a disconnection requiring
          // a full directory resync.
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

          // Backoff so a hard-down server doesn't spin the browser event loop.
          // Cap at 5s; reset occurs in markConnected().
          retryDelayMs = Math.min(5_000, Math.max(retryDelayMs, 250) * (consecutiveFailures <= 1 ? 1 : 2))
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
        await wait(retryDelayMs)
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

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
  }

  // Use globalThis (not window) for the system-resume listener so that
  // test environments can replace globalThis.window with a stub.
  if (typeof globalThis.window !== "undefined") {
    globalThis.window.addEventListener("openchamber:system-resume", onSystemResume)
  }

  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
    }
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.removeEventListener("openchamber:system-resume", onSystemResume)
    }
    abort.abort()
    flushAll()
  }

  return { cleanup }
}
