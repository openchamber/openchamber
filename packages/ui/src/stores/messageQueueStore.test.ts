import { beforeEach, describe, expect, mock, test } from "bun:test"

// The local queue is the VS Code behavior; every other runtime hands the
// queue to the server (see messageQueueStore.server.test.ts).
const desktop = await import("@/lib/desktop")
mock.module("@/lib/desktop", () => ({ ...desktop, isVSCodeRuntime: () => true }))

const {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  useMessageQueueStore,
} = await import("./messageQueueStore")

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("keeps what was captured at queue time on the local message", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const context = [{ kind: "synthetic" as const, text: "conflict payload" }]
    useMessageQueueStore.getState().addToQueue(target, {
      content: "@Builder do it",
      text: "do it",
      agentMention: "Builder",
      context,
    })
    useMessageQueueStore.getState().addToQueue(target, { content: "plain" })

    const [captured, plain] = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(captured?.content).toBe("@Builder do it")
    expect(captured?.text).toBe("do it")
    expect(captured?.agentMention).toBe("Builder")
    expect(captured?.context).toEqual(context)
    expect(plain?.text).toBe("plain")
    expect(plain?.agentMention).toBe(undefined)
    expect(plain?.context).toBe(undefined)
  })

  test("messages persisted before delivery text existed deliver their content", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "runtime-a\n/repo\nsession-1": [{ id: "queued-1", content: "@Builder old", createdAt: 1 }],
      },
    }, 2)

    expect(migrated.queuedMessages?.["runtime-a\n/repo\nsession-1"]?.[0]?.text).toBe("@Builder old")
  })

  test("bounds each queue to the newest 20 messages", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 25; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-5")
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    useMessageQueueStore.getState().markSending(target, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]?.content).toBe("second")

    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().markSending(target, inFlight.id)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })
})

describe("a session that moves", () => {
  const source = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
  const destination = createMessageQueueTarget("session-1", "/repo/moved", "runtime-a")!

  test("a queue waiting on a busy session moves whole, and the old key has nothing to dispatch", () => {
    useMessageQueueStore.getState().addToQueue(source, { content: "queued while busy" })

    useMessageQueueStore.getState().followSessionMove(destination)

    const state = useMessageQueueStore.getState()
    expect(Object.keys(state.queuedMessages)).toEqual([getMessageQueueKey(destination)])
    expect(state.getSendableQueue(destination).map((message) => message.content)).toEqual(["queued while busy"])
    expect(state.getSendableQueue(source)).toEqual([])
  })

  test("a send in flight during the move is delivered once and settles at the destination", () => {
    const store = useMessageQueueStore.getState()
    store.addToQueue(source, { content: "in flight" })
    store.addToQueue(source, { content: "next" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(source)
    useMessageQueueStore.getState().markSending(source, inFlight.id)

    useMessageQueueStore.getState().followSessionMove(destination)
    // The destination must not offer the message that is still being sent.
    expect(useMessageQueueStore.getState().getSendableQueue(destination).map((message) => message.content)).toEqual(["next"])

    // What the auto-send hook does when the send resolves.
    const located = useMessageQueueStore.getState().locateQueuedMessage(source, inFlight.id)
    expect(located).toEqual(destination)
    useMessageQueueStore.getState().removeFromQueue(located, inFlight.id)
    useMessageQueueStore.getState().clearSending(useMessageQueueStore.getState().locateQueuedMessage(source, inFlight.id), inFlight.id)

    const state = useMessageQueueStore.getState()
    expect(state.getQueueForTarget(destination).map((message) => message.content)).toEqual(["next"])
    expect(state.sendingIds).toEqual({})
    expect(Object.keys(state.queuedMessages)).toEqual([getMessageQueueKey(destination)])
  })

  test("a move to the directory the queue is already under changes nothing", () => {
    useMessageQueueStore.getState().addToQueue(source, { content: "queued" })
    const before = useMessageQueueStore.getState().queuedMessages

    useMessageQueueStore.getState().followSessionMove(source)

    expect(useMessageQueueStore.getState().queuedMessages).toBe(before)
  })
})
