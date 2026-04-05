/**
 * Event Pipeline — SSE connection, event coalescing, and batched flush.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvent })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"

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
  /** Called after SSE reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
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

export function createEventPipeline(input: EventPipelineInput) {
  const { sdk, onEvent, onReconnect } = input
  const abort = new AbortController()
  let hasConnected = false

  // Queue state
  let queue: QueuedEvent[] = []
  let buffer: QueuedEvent[] = []
  const coalesced = new Map<string, number>()
  const staleDeltas = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const deltaKey = (directory: string, messageID: string, partID: string) =>
    `${directory}:${messageID}:${partID}`

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

  // Flush — swap queue, dispatch events, skip stale deltas
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
    queue = buffer
    buffer = events
    queue.length = 0
    coalesced.clear()
    staleDeltas.clear()

    last = Date.now()
    // React 18 batches synchronous setState calls automatically,
    // equivalent to SolidJS batch()
    for (const event of events) {
      if (skip && event.payload.type === "message.part.delta") {
        const props = event.payload.properties as { messageID: string; partID: string }
        if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
      }
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

  // SSE loop — iterate SDK global event stream, enqueue with coalescing
  void (async () => {
    while (!abort.signal.aborted) {
      attempt = new AbortController()
      lastEventAt = Date.now()
      const onAbort = () => {
        attempt?.abort()
      }
      abort.signal.addEventListener("abort", onAbort)

      try {
        const events = await sdk.global.event({
          signal: attempt.signal,
          onSseError: (error: unknown) => {
            if (isAbortError(error)) return
            if (streamErrorLogged) return
            streamErrorLogged = true
            console.error("[event-pipeline] stream error", error)
          },
        })

        if (hasConnected) {
          onReconnect?.()
        } else {
          hasConnected = true
        }

        let yielded = Date.now()
        resetHeartbeat()

        // Enqueue event with coalescing + stale delta tracking
        for await (const event of events.stream) {
          resetHeartbeat()
          streamErrorLogged = false
          const payload = (event as { payload?: Event }).payload ?? (event as unknown as Event)
          if (!payload || typeof payload !== "object" || typeof (payload as { type?: unknown }).type !== "string") {
            continue
          }
          const directory = resolveEventDirectory(event, payload)
          const k = key(directory, payload)
          if (k) {
            const i = coalesced.get(k)
            if (i !== undefined) {
              queue[i] = { directory, payload }
              if (payload.type === "message.part.updated") {
                const part = (payload.properties as { part: { messageID: string; id: string } }).part
                staleDeltas.add(deltaKey(directory, part.messageID, part.id))
              }
              continue
            }
            coalesced.set(k, queue.length)
          }
          queue.push({ directory, payload })
          schedule()

          if (Date.now() - yielded < STREAM_YIELD_MS) continue
          yielded = Date.now()
          await wait(0)
        }
      } catch (error) {
        if (!isAbortError(error) && !streamErrorLogged) {
          streamErrorLogged = true
          console.error("[event-pipeline] stream failed", error)
        }
      } finally {
        abort.signal.removeEventListener("abort", onAbort)
        attempt = undefined
        clearHeartbeat()
      }

      if (abort.signal.aborted) return
      await wait(RECONNECT_DELAY_MS)
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
