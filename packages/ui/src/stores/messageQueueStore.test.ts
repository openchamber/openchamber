import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  useMessageQueueStore,
} from "./messageQueueStore"

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
  test("claims a message atomically while keeping it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    const claim = useMessageQueueStore.getState().claimForSend(target, [first.id])!

    expect(claim.messages.map((message) => message.id)).toEqual([first.id])
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().claimForSend(target, [first.id])).toBeNull()

    claim.release()
    expect(useMessageQueueStore.getState().claimForSend(target)?.messages).toHaveLength(2)
  })

  test("acknowledgement removes only the claimed messages while release keeps them", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    const released = useMessageQueueStore.getState().claimForSend(target, [first.id])!
    released.release()
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)

    const acknowledged = useMessageQueueStore.getState().claimForSend(target, [first.id])!
    acknowledged.acknowledge()
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual(["second"])
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().claimForSend(target, [inFlight.id])

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("queue mutations cannot remove an in-flight claim", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "queued" })
    const [inFlight, queued] = useMessageQueueStore.getState().getQueueForTarget(target)
    const claim = useMessageQueueStore.getState().claimForSend(target, [inFlight.id])!

    useMessageQueueStore.getState().removeFromQueue(target, inFlight.id)
    expect(useMessageQueueStore.getState().popToInput(target, inFlight.id)).toBeNull()
    useMessageQueueStore.getState().reorderQueue(target, inFlight.id, queued.id)
    useMessageQueueStore.getState().reorderQueue(target, queued.id, inFlight.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.id)).toEqual([inFlight.id, queued.id])
    useMessageQueueStore.getState().clearAllQueues()

    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.id)).toEqual([inFlight.id])
    claim.release()
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test("capacity pruning evicts a queued item instead of an in-flight item", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    useMessageQueueStore.getState().claimForSend(target, [inFlight.id])

    useMessageQueueStore.getState().addToQueue(target, { content: "message-20" })

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue.some((message) => message.id === inFlight.id)).toBe(true)
    expect(queue.some((message) => message.content === "message-1")).toBe(false)
  })

  test("target pruning retains a target with an in-flight item", () => {
    const inFlightTarget = createMessageQueueTarget("session-0", "/repo-0", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(inFlightTarget, { content: "in flight" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(inFlightTarget)
    useMessageQueueStore.getState().claimForSend(inFlightTarget, [inFlight.id])
    for (let index = 1; index <= 50; index += 1) {
      const target = createMessageQueueTarget(`session-${index}`, `/repo-${index}`, "runtime-a")!
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    expect(useMessageQueueStore.getState().getQueueForTarget(inFlightTarget)).toHaveLength(1)
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(50)
  })
})
