/**
 * Event Pipeline — transport connection, event coalescing, and batched flush.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvent })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { syncDebug } from "./debug"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueuedEvent = {
  directory: string
  payload: Event
}

export type FlushHandler = (events: QueuedEvent[]) => void

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_FRAME_MS = 16
const STREAM_YIELD_MS = 8
const RECONNECT_DELAY_MS = 250
const HEARTBEAT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Pipeline factory
// ---------------------------------------------------------------------------

export type EventPipelineInput = {
  sdk: OpencodeClient
  onEvent: (directory: string, payload: Event) => void
  /** Called after the stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
  transport?: "auto" | "ws" | "sse"
}

type MessageStreamWsFrame = {
  type: "ready" | "event" | "error"
  payload?: unknown
  eventId?: string
  directory?: string
  message?: string
  scope?: "global" | "directory"
}

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//
const WS_FALLBACK_WINDOW_MS = 60_000

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
  const baseUrl = opencodeClient.getBaseUrl()
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const httpUrl = new URL("global/event/ws", resolveAbsoluteUrl(normalizedBase))
  if (lastEventId && lastEventId.length > 0) {
    httpUrl.searchParams.set("lastEventId", lastEventId)
  }
  return toWebSocketUrl(httpUrl.toString())
}

export function createEventPipeline(input: EventPipelineInput) {
  const { sdk, onEvent, onReconnect, transport = "auto" } = input
  const abort = new AbortController()
  let hasConnected = false
  let lastEventId: string | undefined
  let wsFallbackUntil = 0

  // Queue state
  let queue: QueuedEvent[] = []
  let buffer: QueuedEvent[] = []
  const coalesced = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  // Coalesce key — same-type events for the same entity replace earlier ones
  const key = (directory: string, payload: Event): string | undefined => {
    if (payload.type === "session.status") {
      const props = payload.properties as { sessionID: string }
      return `session.status:${directory}:${props.sessionID}`
    }
    if (payload.type === "lsp.updated") {
      return `lsp.updated:${directory}`
    }
    if (payload.type === "message.part.updated") {
      const part = (payload.properties as { part: { messageID: string; id: string } }).part
      return `message.part.updated:${directory}:${part.messageID}:${part.id}`
    }
    return undefined
  }

  // Flush — swap queue, dispatch events
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0
    coalesced.clear()

    last = Date.now()
    syncDebug.pipeline.flush(events.length)
    // React 18 batches synchronous setState calls automatically,
    // equivalent to SolidJS batch()
    for (const event of events) {
      onEvent(event.directory, event.payload)
    }

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  // Helpers
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError" ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")

  let streamErrorLogged = false
  let attempt: AbortController | undefined
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined

  const markConnected = () => {
    if (hasConnected) {
      onReconnect?.()
      return
    }
    hasConnected = true
  }

  const enqueueEvent = (directory: string, payload: Event) => {
    const normalizedPayload = normalizeEventType(payload)
    const k = key(directory, normalizedPayload)
    if (k) {
      const i = coalesced.get(k)
      if (i !== undefined) {
        queue[i] = { directory, payload: normalizedPayload }
        syncDebug.pipeline.coalesced(normalizedPayload.type, k)
        return
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ directory, payload: normalizedPayload })
    schedule()
  }

  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attempt?.abort()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const runSseAttempt = async (signal: AbortSignal) => {
    const events = await sdk.global.event({
      signal,
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
      const socket = new WebSocket(buildGlobalEventWsUrl(lastEventId))

      const cleanup = () => {
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
        streamErrorLogged = false
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
          markConnected()
          return
        }

        if (frame.type === "error") {
          const error = new Error(frame.message || "Message stream WebSocket error")
          if (!opened && transport === "auto") {
            wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
            ;(error as Error & { code?: string }).code = "WS_FALLBACK"
          }
          settleReject(error)
          try {
            socket.close()
          } catch {
            // ignore
          }
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

      socket.onclose = () => {
        if (signal.aborted) {
          settleResolve()
          return
        }

        const error = new Error("Global message stream WebSocket closed")
        if (!opened && transport === "auto") {
          wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
          ;(error as Error & { code?: string }).code = "WS_FALLBACK"
        }
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

  // Transport loop — WS in auto/ws mode, SDK SSE as fallback/compat path.
  void (async () => {
    while (!abort.signal.aborted) {
      attempt = new AbortController()
      lastEventAt = Date.now()
      let retryDelayMs = RECONNECT_DELAY_MS
      const currentTransport = resolveTransport()
      const onAbort = () => {
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
        } else if (!isAbortError(error) && !streamErrorLogged) {
          streamErrorLogged = true
          console.error("[event-pipeline] stream failed", error)
        }
      } finally {
        abort.signal.removeEventListener("abort", onAbort)
        attempt = undefined
        clearHeartbeat()
      }

      if (abort.signal.aborted) return
      if (retryDelayMs > 0) {
        await wait(retryDelayMs)
      }
    }
  })().finally(flush)

  // Visibility handler — abort SSE on heartbeat timeout so the loop reconnects.
  // The reconnect triggers onReconnect above, which lets consumers resync state.
  const onVisibility = () => {
    if (typeof document === "undefined") return
    if (document.visibilityState !== "visible") return
    if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
    attempt?.abort()
  }

  // pageshow handler — fires on back-forward cache restore (common on mobile PWA).
  // bfcache restores the page without a fresh load, so SSE state may be stale.
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    attempt?.abort()
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
  }

  // Cleanup — abort SSE, flush remaining events, remove listeners
  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
    }
    abort.abort()
    flush()
  }

  return { cleanup }
}
