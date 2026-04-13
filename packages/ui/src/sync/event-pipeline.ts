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
  /** Called after SSE reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
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

// Per-directory queue state. Each directory owns an independent flush timer
// so a busy directory's delta storm cannot block another directory's events
// from reaching the UI (head-of-line blocking across sessions).
type DirectoryQueue = {
  queue: Event[]
  buffer: Event[]
  coalesced: Map<string, number>
  staleDeltas: Set<string>
  timer: ReturnType<typeof setTimeout> | undefined
  last: number
}

export function createEventPipeline(input: EventPipelineInput) {
  const { sdk, onEvent, onReconnect } = input
  const abort = new AbortController()
  let hasConnected = false

  // One queue + one flush timer per directory. Lazily created on first event.
  const directories = new Map<string, DirectoryQueue>()

  const getOrCreateDir = (directory: string): DirectoryQueue => {
    let d = directories.get(directory)
    if (d) return d
    d = {
      queue: [],
      buffer: [],
      coalesced: new Map(),
      staleDeltas: new Set(),
      timer: undefined,
      last: 0,
    }
    directories.set(directory, d)
    return d
  }

  const deltaKey = (messageID: string, partID: string) => `${messageID}:${partID}`

  // Coalesce key — same-type events for the same entity replace earlier ones.
  // Keys are scoped to a single directory's queue, so directory is implicit.
  // message.part.delta is a special case: consecutive deltas for the same
  // (messageID, partID, field) are accumulated (string-concatenated) rather
  // than replaced, because the reducer is a pure append and merging is
  // semantically identical to applying each delta individually.
  const key = (payload: Event): string | undefined => {
    if (payload.type === "session.status") {
      const props = payload.properties as { sessionID: string }
      return `session.status:${props.sessionID}`
    }
    if (payload.type === "lsp.updated") {
      return `lsp.updated`
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

  // Flush one directory — swap queue, dispatch events, skip stale deltas.
  // React 18 auto-batching still collapses the setState calls inside a single
  // directory's flush into one render pass.
  const flushDir = (directory: string) => {
    const d = directories.get(directory)
    if (!d) return
    if (d.timer) {
      clearTimeout(d.timer)
      d.timer = undefined
    }
    if (d.queue.length === 0) return

    const events = d.queue
    const skip = d.staleDeltas.size > 0 ? new Set(d.staleDeltas) : undefined
    d.queue = d.buffer
    d.buffer = events
    d.queue.length = 0
    d.coalesced.clear()
    d.staleDeltas.clear()

    d.last = Date.now()
    syncDebug.pipeline.flush(events.length)
    for (const payload of events) {
      if (skip && payload.type === "message.part.delta") {
        const props = payload.properties as { messageID: string; partID: string }
        if (skip.has(deltaKey(props.messageID, props.partID))) continue
      }
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
    d.timer = setTimeout(() => flushDir(directory), Math.max(0, FLUSH_FRAME_MS - elapsed))
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
          const normalizedPayload = normalizeEventType(payload)
          const directory = resolveEventDirectory(event, normalizedPayload)
          const d = getOrCreateDir(directory)
          const k = key(normalizedPayload)
          if (k) {
            const i = d.coalesced.get(k)
            if (i !== undefined) {
              if (normalizedPayload.type === "message.part.delta") {
                // Accumulate delta strings — append to the already-queued event
                // rather than replacing it. The reducer is a pure string append so
                // this is semantically identical to applying each delta separately.
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
                if (normalizedPayload.type === "message.part.updated") {
                  const part = (normalizedPayload.properties as { part: { messageID: string; id: string } }).part
                  d.staleDeltas.add(deltaKey(part.messageID, part.id))
                }
              }
              syncDebug.pipeline.coalesced(normalizedPayload.type, k)
              continue
            }
            d.coalesced.set(k, d.queue.length)
          }
          d.queue.push(normalizedPayload)
          scheduleDir(directory)

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
  })().finally(flushAll)

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
    flushAll()
  }

  return { cleanup }
}
