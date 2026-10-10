import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import { adoptRelayTunnel, deactivateRelayTunnel } from "@/lib/relay/runtime-tunnel"
import type { RelayTunnelClient, RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { useAuthSessionStore } from "@/lib/runtime-auth-expiry"
import { classifyStreamPayload, createEventPipeline } from "./event-pipeline"

const failAfter = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
})

const base = { id: "evt_1", created: 1000, location: { directory: "/repo" } }
const durable = { aggregateID: "ses_1", seq: 1, version: 1 as const }

function textEnded(text: string): OpenCodeEvent {
  return { ...base, type: "session.text.ended", durable, data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text } }
}

function textDelta(delta: string): OpenCodeEvent {
  return { ...base, type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta } }
}

function statusEvent(type: "busy" | "retry"): OpenCodeEvent {
  return {
    ...base,
    type: "session.status",
    data: {
      sessionID: "ses_1",
      status: type === "busy" ? { type } : { type, attempt: 1, message: "retrying", next: 1 },
    },
  }
}

/** A raw stream payload: wire events, or OpenChamber's own bridge events. */
type StreamPayload = OpenCodeEvent | { type: string; properties: Record<string, string> }

/** `keepalives` counts SSE comments sent before the events. They are activity without an event. */
function createSdk(events: StreamPayload[], streamFinished: () => void, keepalives = 0): OpenCodeClient {
  const subscribe = ({ signal, onActivity }: { signal?: AbortSignal; onActivity?: () => void }) => ({
    async *[Symbol.asyncIterator]() {
      for (let sent = 0; sent < keepalives; sent += 1) {
        onActivity?.()
      }
      for (const payload of events) {
        yield payload as OpenCodeEvent
      }
      streamFinished()
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
  })
  // SAFETY: the pipeline only touches `event.subscribe` on the client.
  return { event: { subscribe } } as unknown as OpenCodeClient
}

const describeEvent = (event: SyncEvent): string => {
  if (event.type === "message.part.delta") return `delta:${event.properties.delta}`
  if (event.type === "message.part.updated" && event.properties.part.type === "text") return `updated:${event.properties.part.text}`
  return event.type
}

async function collect(events: StreamPayload[], expected: number): Promise<{ directory: string; events: SyncEvent[] }> {
  let resolveStreamFinished!: () => void
  const streamFinished = new Promise<void>((resolve) => {
    resolveStreamFinished = resolve
  })
  let resolveDelivered!: () => void
  const deliveredAll = new Promise<void>((resolve) => {
    resolveDelivered = resolve
  })
  const delivered: SyncEvent[] = []
  let deliveredDirectory = ""
  const pipeline = createEventPipeline({
    sdk: createSdk(events, resolveStreamFinished),
    onEvents: (directory, batch) => {
      deliveredDirectory = directory
      delivered.push(...batch)
      if (delivered.length >= expected) resolveDelivered()
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
  return { directory: deliveredDirectory, events: delivered }
}

describe("createEventPipeline", () => {
  test("translates wire events, routes them by location, and delivers one ordered batch", async () => {
    const { directory, events } = await collect([textEnded("a"), textDelta("b"), textEnded("ab")], 3)
    expect(directory).toBe("/repo")
    expect(events.map(describeEvent)).toEqual(["updated:a", "delta:b", "updated:ab"])
  })

  test("merges consecutive deltas for one part", async () => {
    const { events } = await collect([textEnded(""), textDelta("b"), textDelta("c")], 2)
    expect(events.map(describeEvent)).toEqual(["updated:", "delta:bc"])
  })

  test("does not merge deltas across an intervening part snapshot", async () => {
    // The "ab" snapshot is a coalescing barrier: the trailing "c" delta must
    // stay a separate event after it, not merge into the "b" delta queued
    // before the snapshot (which the snapshot would then overwrite).
    const { events } = await collect([textEnded("a"), textDelta("b"), textEnded("ab"), textDelta("c")], 4)
    expect(events.map(describeEvent)).toEqual(["updated:a", "delta:b", "updated:ab", "delta:c"])
  })

  test("does not coalesce session status across an idle barrier", async () => {
    const { events } = await collect(
      [statusEvent("busy"), { ...base, type: "session.idle", data: { sessionID: "ses_1" } }, statusEvent("retry")],
      3,
    )
    expect(events.map((event) => event.type)).toEqual(["session.status", "session.idle", "session.status"])
    const last = events[2]
    expect(last.type === "session.status" && last.properties.status.type).toBe("retry")
  })

  test("folds successive session patches into one", async () => {
    const { events } = await collect(
      [
        { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "New" } },
        { ...base, type: "session.usage.updated", data: { sessionID: "ses_1", cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
      ],
      1,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "session.patched", properties: { patch: { title: "New", cost: 1, time: { updated: 1000 } } } })
  })

  test("bridges openchamber session status events into session.status", async () => {
    const { directory, events } = await collect(
      [{ type: "openchamber:session-status", properties: { sessionID: "ses_1", status: "idle" } }],
      1,
    )
    expect(directory).toBe("global")
    expect(events[0]).toEqual({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
  })

  test("bridges openchamber archive announcements into session patches", async () => {
    const { events } = await collect(
      [{ type: "openchamber:session-archived", properties: { sessionID: "ses_1", archivedAt: 42 } as never }],
      1,
    )
    expect(events[0]).toEqual({ type: "session.patched", properties: { sessionID: "ses_1", patch: { time: { archived: 42 } } } })
  })

  test("bridges openchamber metadata announcements into session patches", async () => {
    const { events } = await collect(
      [{ type: "openchamber:session-metadata", properties: { sessionID: "ses_1", metadata: { pinned: true } } as never }],
      1,
    )
    expect(events[0]).toEqual({ type: "session.patched", properties: { sessionID: "ses_1", patch: { metadata: { pinned: true } } } })
  })

  test("passes OpenChamber notification and auto-accept frames through typed", async () => {
    const { events } = await collect(
      [
        { type: "openchamber:notification", properties: { kind: "agent-complete", sessionId: "ses_1", title: "Done" } },
        { type: "openchamber:permission-auto-accept.updated", properties: { sessions: { ses_1: true }, modes: { ses_1: "safety" }, revision: 3 } as never },
      ],
      2,
    )
    expect(events[0]).toEqual({ type: "openchamber.notification", properties: { kind: "agent-complete", sessionId: "ses_1", title: "Done" } })
    expect(events[1]).toEqual({ type: "openchamber.permission-auto-accept", properties: { sessions: { ses_1: true }, modes: { ses_1: "safety" }, revision: 3 } })
  })

  test("ignores payloads that are neither wire events nor bridge events", async () => {
    const { events } = await collect([{ type: "something.else", properties: {} }, textEnded("x")], 1)
    expect(events.map(describeEvent)).toEqual(["updated:x"])
  })

  test("hands a space-stream announcement to its owner and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const announced: Array<{ spaceId: string; status: string; wasReady: boolean }> = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-stream", properties: { spaceId: "a1b2c3d4e5f6", status: "connected", wasReady: false, timestamp: 1 } as never },
        { type: "openchamber:space-stream", properties: { spaceId: "not-an-id", status: "connected", wasReady: false } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceStream: (details) => { announced.push(details) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(announced).toEqual([{ spaceId: "a1b2c3d4e5f6", status: "connected", wasReady: false }])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("hands a creation step of a space to its owner, failure included, and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const steps: Array<{ spaceId: string; step: string; failure: { code: string; message: string } | null }> = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "creating", failure: null, timestamp: 1 } as never },
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "failed", failure: { code: "docker_daemon_unreachable", message: "down", details: null }, timestamp: 2 } as never },
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "dancing", failure: null } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceProgress: (progress) => { steps.push(progress) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(steps).toEqual([
      { spaceId: "a1b2c3d4e5f6", step: "creating", failure: null },
      { spaceId: "a1b2c3d4e5f6", step: "failed", failure: { code: "docker_daemon_unreachable", message: "down" } },
    ])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("hands a move of a space's setup commands to its owner and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const moved: string[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-setup", properties: { spaceId: "a1b2c3d4e5f6", timestamp: 1 } as never },
        { type: "openchamber:space-setup", properties: { spaceId: "../etc" } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceSetup: (spaceId) => { moved.push(spaceId) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(moved).toEqual(["a1b2c3d4e5f6"])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("reports keepalives that carry no event as stream activity", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([textEnded("a")], resolveStreamFinished, 2),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onStreamActivity: () => { activity += 1 },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    // Two keepalives and one event; only the event is delivered.
    expect(activity).toBe(3)
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("reports no stream activity for an attempt that has received nothing", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], resolveStreamFinished),
      onEvents: () => undefined,
      onStreamActivity: () => { activity += 1 },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(activity).toBe(0)
  })

  describe("while the OpenChamber session is expired", () => {
    afterEach(() => {
      useAuthSessionStore.getState().markAuthenticated()
    })

    /**
     * Every attempt is refused, and the first refusal confirms the expiry. The failure carries no
     * HTTP status, as a refused SSE request or WebSocket upgrade does in a browser, so the
     * pipeline's normal retry backoff applies.
     */
    const createUnauthorizedSdk = (onAttempt: () => void): OpenCodeClient => {
      const client: Pick<OpenCodeClient, "event"> = {
        event: {
          subscribe: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                onAttempt()
                useAuthSessionStore.getState().markExpired()
                throw new Error("UI authentication required")
              },
            }),
          }),
        },
      }
      // SAFETY: the pipeline only touches `event.subscribe` on the client.
      return client as OpenCodeClient
    }

    test("stops reconnecting until the user logs in, then reconnects at once", async () => {
      let attempts = 0
      const pipeline = createEventPipeline({
        sdk: createUnauthorizedSdk(() => { attempts += 1 }),
        onEvents: () => undefined,
        transport: "sse",
        heartbeatTimeoutMs: 60_000,
      })
      try {
        // The retry backoff starts at 250 ms and doubles; three more attempts would fit here.
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        expect(attempts).toBe(1)

        useAuthSessionStore.getState().markAuthenticated()
        for (let i = 0; i < 20 && attempts < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(attempts).toBe(2)
      } finally {
        pipeline.cleanup()
      }
    })

    test("a pipeline cleaned up while waiting for the login never reconnects", async () => {
      let attempts = 0
      const pipeline = createEventPipeline({
        sdk: createUnauthorizedSdk(() => { attempts += 1 }),
        onEvents: () => undefined,
        transport: "sse",
        heartbeatTimeoutMs: 60_000,
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      pipeline.cleanup()
      useAuthSessionStore.getState().markAuthenticated()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(attempts).toBe(1)
    })
  })
})

/** A relay tunnel socket the test drives by hand. */
function createFakeSocket(): RelayTunnelWebSocket {
  let readyState = 1
  return {
    get readyState() { return readyState },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => { readyState = 3 },
  }
}

describe("createEventPipeline over the WebSocket transport", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: Object.assign(new EventTarget(), { location: new URL("http://runtime.test") }),
      configurable: true,
      writable: true,
    })
    // A valid URL token lets the attempt open the socket without minting one.
    setRuntimeUrlAuthToken("fixture-url-token", Date.now() + 10 * 60_000)
  })

  afterEach(() => {
    deactivateRelayTunnel()
    clearRuntimeUrlAuthToken()
    Reflect.deleteProperty(globalThis, "window")
  })

  test("counts a heartbeat frame as stream activity without delivering an event", async () => {
    const paths: string[] = []
    const sockets: RelayTunnelWebSocket[] = []
    const tunnel: RelayTunnelClient = {
      async fetch() { throw new Error("the WebSocket transport must not fetch") },
      openWebSocket(pathWithQuery) {
        paths.push(pathWithQuery)
        const socket = createFakeSocket()
        sockets.push(socket)
        return socket
      },
      getStatus: () => ({ state: "connected" }),
      subscribeStatus: () => () => undefined,
      close: () => undefined,
    }
    adoptRelayTunnel({ relayUrl: "wss://relay.test", serverId: "fixture", hostEncPubJwk: {} }, tunnel)
    const delivered: SyncEvent[] = []
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => undefined),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onStreamActivity: () => { activity += 1 },
      transport: "ws",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      for (let i = 0; i < 20 && sockets.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sockets).toHaveLength(1)
      expect(paths[0]).toContain("/api/global/event/ws")
      const socket = sockets[0]
      socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      socket.onmessage?.({
        data: JSON.stringify({ type: "event", payload: { type: "openchamber:heartbeat", timestamp: 1 }, directory: "global" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    // The ready frame and the heartbeat frame both prove the socket is alive. Neither is an event.
    expect(activity).toBe(2)
    expect(delivered).toEqual([])
  })
})

describe("classifyStreamPayload", () => {
  test("classifies each payload kind by its type", () => {
    expect(classifyStreamPayload(textDelta("a"), undefined)).toMatchObject({ kind: "events", events: [{ directory: "/repo" }] })
    expect(classifyStreamPayload({ type: "openchamber:space-setup", properties: { spaceId: "0123456789ab" } }, undefined))
      .toEqual({ kind: "space-setup", spaceId: "0123456789ab" })
    expect(classifyStreamPayload({ type: "openchamber:space-setup", properties: { spaceId: "bad" } }, undefined))
      .toEqual({ kind: "events", events: [] })
    expect(classifyStreamPayload({ type: "openchamber:session-archived", properties: { sessionID: "ses_1", archivedAt: 5 } }, "/frame"))
      .toMatchObject({ kind: "events", events: [{ directory: "/frame", event: { type: "session.patched" } }] })
    expect(classifyStreamPayload({ nothing: true }, undefined)).toEqual({ kind: "events", events: [] })
    expect(classifyStreamPayload("text", undefined)).toEqual({ kind: "events", events: [] })
  })

  // Each delta used to be tried against nine OpenChamber schemas before the
  // wire schema; failed zod parses build issue objects, so this cost ~37us per
  // delta (750ms for 20k on an M-series laptop). Dispatching on `type` brings
  // it under 1us. The bound is loose enough for slow CI and far below the old cost.
  test("classifies a stream of text deltas without trying unrelated schemas", () => {
    const payloads = Array.from({ length: 20_000 }, (_, index) => textDelta(`chunk ${index}`))
    const started = performance.now()
    let events = 0
    for (const payload of payloads) {
      const classified = classifyStreamPayload(payload, undefined)
      if (classified.kind === "events") events += classified.events.length
    }
    const elapsed = performance.now() - started
    expect(events).toBe(20_000)
    expect(elapsed).toBeLessThan(300)
  })
})
