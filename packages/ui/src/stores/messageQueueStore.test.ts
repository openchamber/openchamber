import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  parseMessageQueueKey,
  selectQueuedMessagesForSubmit,
  shouldQueueComposerSubmission,
  useMessageQueueStore,
  withMessageQueueStateLock,
  withMessageQueueTargetLock,
  type QueuedMessage,
} from "./messageQueueStore"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, deletedTargets: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", async () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    await useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    await useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

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

  test("preserves v5 send identity as dispatched while migrating the previous format", () => {
    const key = getMessageQueueKey(createMessageQueueTarget("session-1", "/repo", "runtime-a")!)
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [key]: [{
          id: "queued-1",
          content: "pending confirmation",
          createdAt: 1,
          sendAttempt: { messageID: "msg_durable" },
        }],
      },
    }, 5)

    expect(migrated.queuedMessages?.[key]?.[0]?.sendAttempt?.messageID).toBe("msg_durable")
    expect(migrated.queuedMessages?.[key]?.[0]?.sendAttempt?.dispatched).toBe(true)
  })

  test("drops malformed durable send identity during hydration", () => {
    const key = getMessageQueueKey(createMessageQueueTarget("session-1", "/repo", "runtime-a")!)
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [key]: [{
          id: "queued-1",
          content: "retry safely",
          createdAt: 1,
          sendAttempt: { messageID: "", dispatched: true },
        }],
      },
    }, 3)

    expect(migrated.queuedMessages?.[key]?.[0]?.sendAttempt).toBe(undefined)
  })

  test("migrates version 4 tombstones with bounded retention", () => {
    const now = Date.now()
    const deletedTargets = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [`target-${index}`, now - index]),
    )
    deletedTargets.expired = now - (31 * 24 * 60 * 60 * 1000)

    const migrated = migrateMessageQueueState({ deletedTargets }, 4)

    expect(Object.keys(migrated.deletedTargets ?? {})).toHaveLength(110)
    expect(migrated.deletedTargets?.["target-0"]).toBe(now)
    expect(migrated.deletedTargets?.["target-109"]).toBe(now - 109)
    expect(migrated.deletedTargets?.expired).toBe(undefined)
  })

  test("rejects new entries once a queue reaches 20 messages", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 25; index += 1) {
      await useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-0")
    expect(queue.at(-1)?.content).toBe("message-19")
  })

  test("never evicts a durable send attempt when a queue reaches its cap", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      await useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }
    const [durable, evictable] = useMessageQueueStore.getState().getQueueForTarget(target)
    await useMessageQueueStore.getState().recordSendAttempt(target, durable.id, "msg_durable")

    expect(await useMessageQueueStore.getState().addToQueue(target, { content: "newest" })).toBe(false)

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue.some((queued) => queued.id === durable.id)).toBe(true)
    expect(queue.some((queued) => queued.id === evictable.id)).toBe(true)
    expect(queue.at(-1)?.content).toBe("message-19")
  })

  test("rejects an enqueue after the target has been deleted", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().purgeQueue(target)

    expect(await useMessageQueueStore.getState().addToQueue(target, { content: "stale" })).toBe(false)
    expect(await useMessageQueueStore.getState().markSending(target, "queued-stale")).toBe(false)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
  })

  test("drops expired tombstones during a later queue purge", async () => {
    const now = Date.now()
    useMessageQueueStore.setState({
      deletedTargets: {
        retained: now,
        expired: now - (31 * 24 * 60 * 60 * 1000),
      },
    })
    const target = createMessageQueueTarget("session-new", "/repo", "runtime-a")!

    await useMessageQueueStore.getState().purgeQueue(target)

    const tombstones = useMessageQueueStore.getState().deletedTargets
    expect(Object.keys(tombstones)).toHaveLength(2)
    expect(tombstones[getMessageQueueKey(target)]).toBeGreaterThan(0)
    expect(tombstones.retained).toBe(now)
    expect(tombstones.expired).toBe(undefined)
  })

  test("rejects a browser enqueue when durable storage cannot confirm the new entry", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    const values = new Map<string, string>()
    const storage: Storage = {
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => { values.delete(key) },
      setItem: (key, value) => { values.set(key, value) },
      get length() { return values.size },
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } })
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })

    try {
      const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
      expect(await useMessageQueueStore.getState().addToQueue(target, { content: "not durable" })).toBe(false)
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
      if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  test("does not reorder messages across a protected queue entry", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "protected" })
    await useMessageQueueStore.getState().addToQueue(target, { content: "second" })
    await useMessageQueueStore.getState().addToQueue(target, { content: "third" })
    const [first, , third] = useMessageQueueStore.getState().getQueueForTarget(target)
    await useMessageQueueStore.getState().recordSendAttempt(target, first.id, "msg_unknown")

    await useMessageQueueStore.getState().reorderQueue(target, third.id, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual([
      "protected",
      "second",
      "third",
    ])
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    await store.addToQueue(target, { content: "first" })
    await store.addToQueue(target, { content: "second" })
    const [first] = useMessageQueueStore.getState().getQueueForTarget(target)

    await useMessageQueueStore.getState().markSending(target, first.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]?.content).toBe("second")

    await useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    await store.addToQueue(target, { content: "in flight" })
    await store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    await useMessageQueueStore.getState().markSending(target, inFlight.id)

    await useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    await useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test("retains and clears the durable identity of an outcome-unknown send", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "in flight" })
    const [queued] = useMessageQueueStore.getState().getQueueForTarget(target)

    await useMessageQueueStore.getState().recordSendAttempt(target, queued.id, "msg_durable")
    useMessageQueueStore.setState({ sendingIds: {} })
    await useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.sendAttempt).toEqual({
      messageID: "msg_durable",
      dispatched: false,
    })
    expect(await useMessageQueueStore.getState().popToInput(target, queued.id)).toBeNull()

    await useMessageQueueStore.getState().clearSendAttempt(target, queued.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.sendAttempt).toBe(undefined)
  })

  test("allows only one transient sender to claim a queued message", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "send once" })
    const [queued] = useMessageQueueStore.getState().getQueueForTarget(target)

    expect(await useMessageQueueStore.getState().markSending(target, queued.id)).toBe(true)
    expect(await useMessageQueueStore.getState().markSending(target, queued.id)).toBe(false)
  })

  test("never replaces an existing durable send identity", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "send once" })
    const [queued] = useMessageQueueStore.getState().getQueueForTarget(target)

    expect(await useMessageQueueStore.getState().recordSendAttempt(target, queued.id, "msg_original")).toBe(true)
    expect(await useMessageQueueStore.getState().recordSendAttempt(target, queued.id, "msg_conflict")).toBe(false)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.sendAttempt?.messageID).toBe("msg_original")
  })

  test("marks the durable identity only when dispatch is about to start", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    await useMessageQueueStore.getState().addToQueue(target, { content: "send once" })
    const [queued] = useMessageQueueStore.getState().getQueueForTarget(target)

    await useMessageQueueStore.getState().recordSendAttempt(target, queued.id, "msg_original")
    expect(await useMessageQueueStore.getState().markSendAttemptDispatched(target, queued.id, "msg_other")).toBe(false)
    expect(await useMessageQueueStore.getState().markSendAttemptDispatched(target, queued.id, "msg_original")).toBe(true)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.sendAttempt).toEqual({
      messageID: "msg_original",
      dispatched: true,
    })
  })
})

describe("composer queue selection", () => {
  const queue: QueuedMessage[] = [
    { id: "queued-1", content: "first", createdAt: 1, sendAttempt: { messageID: "msg_unknown", dispatched: true } },
    { id: "queued-2", content: "second", createdAt: 2 },
  ]

  test("does not overtake an outcome-unknown FIFO head", () => {
    expect(selectQueuedMessagesForSubmit(queue, [], false)).toEqual([])
  })

  test("does not let an explicit send overtake an outcome-unknown head", () => {
    expect(selectQueuedMessagesForSubmit(queue, [], false, "queued-2")).toEqual([])
  })

  test("allows an explicit retry of the outcome-unknown head", () => {
    expect(selectQueuedMessagesForSubmit(queue, [], false, "queued-1")).toEqual([queue[0]])
  })

  test("allows an explicit item to pass ordinary queued predecessors", () => {
    const ordinaryQueue = queue.map((message) => ({ ...message, sendAttempt: undefined }))
    expect(selectQueuedMessagesForSubmit(ordinaryQueue, [], false, "queued-2")).toEqual([ordinaryQueue[1]])
  })

  test("does not merge queued content with composer content", () => {
    expect(selectQueuedMessagesForSubmit([{ id: "queued-1", content: "first", createdAt: 1 }], [], true)).toEqual([])
  })

  test("queues fresh composer content behind an existing dispatch except local commands", () => {
    expect(shouldQueueComposerSubmission(queue, true, false, false, false)).toBe(true)
    expect(shouldQueueComposerSubmission([], true, false, false, false)).toBe(false)
    expect(shouldQueueComposerSubmission([], true, false, false, true)).toBe(true)
    expect(shouldQueueComposerSubmission(queue, true, true, false, true)).toBe(false)
    expect(shouldQueueComposerSubmission(queue, true, false, true, true)).toBe(false)
  })
})

describe("queue persistence transactions", () => {
  test("serializes whole-store mutations", async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    let firstStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withMessageQueueStateLock(async () => {
      order.push("first-start")
      firstStarted()
      await blocked
      order.push("first-end")
    })
    await started
    const second = withMessageQueueStateLock(() => {
      order.push("second")
    })

    await Promise.resolve()
    expect(order).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  test("allows only one dispatcher to own a target", async () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    let releaseFirst: () => void = () => undefined
    let firstStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = withMessageQueueTargetLock(target, async () => {
      firstStarted()
      await blocked
    })
    await started

    expect(await withMessageQueueTargetLock(target, async () => undefined, { ifAvailable: true })).toBe(false)
    releaseFirst()
    expect(await first).toBe(true)
  })

  test("declines browser dispatch without native Web Locks", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} })
    let dispatched = false

    try {
      const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
      const acquired = await withMessageQueueTargetLock(target, async () => {
        dispatched = true
      })

      expect(acquired).toBe(false)
      expect(dispatched).toBe(false)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator)
      else Reflect.deleteProperty(globalThis, "navigator")
    }
  })

})
