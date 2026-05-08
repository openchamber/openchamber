import { describe, expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"

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
})
