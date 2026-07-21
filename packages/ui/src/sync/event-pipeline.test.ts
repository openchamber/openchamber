import { describe, expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { sdkGlobalEventFetch } from "./sdk-global-event-fetch"

const failAfter = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
})

function partUpdatedEvent(text: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text,
      },
    },
  } as Event
}

function deltaEvent(delta: string): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    },
  } as Event
}

function createSdk(events: Event[], streamFinished: () => void): OpencodeClient {
  return {
    global: {
      event: async ({ signal }: { signal: AbortSignal }) => ({
        stream: (async function* () {
          for (const payload of events) {
            yield { directory: "/repo", payload }
          }
          streamFinished()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }),
    },
  } as unknown as OpencodeClient
}

describe("createEventPipeline", () => {
  test("passes the canonical runtime fetch adapter to the SDK SSE stream", async () => {
    let resolveFetch!: (fetchOverride: typeof fetch | undefined) => void
    const receivedFetch = new Promise<typeof fetch | undefined>((resolve) => {
      resolveFetch = resolve
    })
    const sdk = {
      global: {
        event: async (options: { fetch?: typeof fetch; signal: AbortSignal }) => {
          resolveFetch(options.fetch)
          return {
            stream: (async function* () {
              await new Promise<void>((resolve) => {
                options.signal.addEventListener("abort", () => resolve(), { once: true })
              })
              yield { payload: undefined }
            })(),
          }
        },
      },
    } as unknown as OpencodeClient
    const pipeline = createEventPipeline({
      sdk,
      onEvent: () => undefined,
      transport: "sse",
    })

    try {
      expect(await Promise.race([receivedFetch, failAfter(500)])).toBe(sdkGlobalEventFetch)
    } finally {
      pipeline.cleanup()
    }
  })

  test("preserves part update order around text deltas", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 3) {
          resolveDelivered()
        }
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["updated:a", "delta:b", "updated:ab"])
  })

  test("does not merge deltas across an intervening part snapshot", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
        deltaEvent("c"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 4) {
          resolveDelivered()
        }
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, new Promise<void>((resolve) => setTimeout(resolve, 300))])
    } finally {
      pipeline.cleanup()
    }

    // The "ab" snapshot is a coalescing barrier: the trailing "c" delta must
    // stay a separate event after it, not merge into the "b" delta queued
    // before the snapshot (which the snapshot would then overwrite).
    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["updated:a", "delta:b", "updated:ab", "delta:c"])
  })

  test("normalizes openchamber session status events", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: (event: Event) => void
    const deliveredEvent = new Promise<Event>((resolve) => {
      resolveDelivered = resolve
    })
    const pipeline = createEventPipeline({
      sdk: createSdk([
        {
          type: "openchamber:session-status",
          properties: {
            sessionID: "ses_1",
            status: "idle",
          },
        } as unknown as Event,
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        resolveDelivered(payload)
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      const delivered = await Promise.race([deliveredEvent, failAfter(500)])
      expect(delivered.type).toBe("session.status")
      expect(delivered.properties).toEqual({
        sessionID: "ses_1",
        status: { type: "idle" },
      })
    } finally {
      pipeline.cleanup()
    }
  })
})
