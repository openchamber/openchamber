import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  isQueueMessageDispatchable,
  migrateMessageQueueState,
  normalizeFollowUpBehavior,
  parseMessageQueueKey,
  resolveMainSessionSendDisposition,
  useMessageQueueStore,
} from "./messageQueueStore"
import { getRuntimeKey } from "../lib/runtime-switch"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, queueDeletionGenerations: {}, sendingIds: {} })
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

  test("isolates session IDs within one runtime and directory", () => {
    const first = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const second = createMessageQueueTarget("session-2", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(first, { content: "first session" })
    useMessageQueueStore.getState().addToQueue(second, { content: "second session" })

    expect(useMessageQueueStore.getState().getQueueForTarget(first)[0]?.content).toBe("first session")
    expect(useMessageQueueStore.getState().getQueueForTarget(second)[0]?.content).toBe("second session")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("uses one key for Windows path casing and separators but not POSIX casing", () => {
    const windowsSlash = createMessageQueueTarget("session-1", "C:/Repo", "runtime-a")!
    const windowsBackslash = createMessageQueueTarget("session-1", "c:\\repo", "runtime-a")!
    const uncSlash = createMessageQueueTarget("session-2", "//Server/Share/Repo", "runtime-a")!
    const uncBackslash = createMessageQueueTarget("session-2", "\\\\server\\share\\repo", "runtime-a")!
    const posixUpper = createMessageQueueTarget("session-3", "/Repo", "runtime-a")!
    const posixLower = createMessageQueueTarget("session-3", "/repo", "runtime-a")!

    expect(windowsSlash.directory).toBe("C:/Repo")
    expect(getMessageQueueKey(windowsSlash)).toBe(getMessageQueueKey(windowsBackslash))
    expect(getMessageQueueKey(uncSlash)).toBe(getMessageQueueKey(uncBackslash))
    expect(getMessageQueueKey(posixUpper)).not.toBe(getMessageQueueKey(posixLower))

    useMessageQueueStore.getState().addToQueue(windowsSlash, { content: "from Windows" })
    expect(useMessageQueueStore.getState().getQueueForTarget(windowsBackslash)[0]?.content).toBe("from Windows")
  })

  test("migrates aliased v2 queue keys into one FIFO queue without losing item data", () => {
    const target = createMessageQueueTarget("session-1", "C:/Repo", "runtime-a")!
    const canonicalKey = getMessageQueueKey(target)
    const aliasedKey = ["runtime-a", "c:\\Repo\\", "session-1"].join("\n")
    const first = {
      id: "queued-old",
      content: "old alias",
      createdAt: 1,
      additionalParts: [{ text: "old context", synthetic: true }],
      sendConfig: { providerID: "provider-old", modelID: "model-old", agent: "agent-old", variant: "variant-old" },
    }
    const second = {
      id: "queued-new",
      content: "canonical key",
      createdAt: 2,
      additionalParts: [{ text: "new context", synthetic: true }],
      sendConfig: { providerID: "provider-new", modelID: "model-new", agent: "agent-new", variant: "variant-new" },
    }

    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [aliasedKey]: [first],
        [canonicalKey]: [second],
      },
    }, 2)

    expect(migrated.queuedMessages).toEqual({ [canonicalKey]: [first, second] })
  })

  test("quarantines an unparseable v2 queue key without discarding its messages", () => {
    const target = createMessageQueueTarget("session-valid", "/repo", "runtime-a")!
    const valid = { id: "queued-valid", content: "valid", createdAt: 1 }
    const malformed = { id: "queued-malformed", content: "malformed", createdAt: 2 }

    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [getMessageQueueKey(target)]: [valid],
        "session-only": [malformed],
      },
    }, 2)

    expect(migrated.queuedMessages).toEqual({ [getMessageQueueKey(target)]: [valid] })
    expect(migrated.quarantinedLegacyMessages).toEqual({ "session-only": [malformed] })
  })

  test("quarantines composite keys with extra fields", () => {
    const target = createMessageQueueTarget("session-extra", "/repo", "runtime-a")!
    const extraFieldKey = `${getMessageQueueKey(target)}\nextra`
    const queued = { id: "queued-extra", content: "extra field", createdAt: 1 }

    expect(parseMessageQueueKey(extraFieldKey)).toBeNull()

    const migrated = migrateMessageQueueState({
      queuedMessages: { [extraFieldKey]: [queued] },
    }, 3)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages).toEqual({ [extraFieldKey]: [queued] })
  })

  test("canonicalizes a noncanonical Windows alias from the prior v4 snapshot so it remains reachable", () => {
    const target = createMessageQueueTarget("session-v4", "C:/Repo", "runtime-a")!
    const aliasKey = ["runtime-a", "c:\\Repo\\", "session-v4"].join("\n")
    const queued = { id: "queued-v4", content: "v4 alias", createdAt: 1 }

    const migrated = migrateMessageQueueState({
      queuedMessages: { [aliasKey]: [queued] },
    }, 4)

    expect(migrated.queuedMessages).toEqual({ [getMessageQueueKey(target)]: [queued] })
  })

  test("keeps valid sibling queues when persisted queue values or entries are malformed", () => {
    const validTarget = createMessageQueueTarget("session-valid", "/repo", "runtime-a")!
    const quarantinedTarget = createMessageQueueTarget("session-quarantined", "/repo", "runtime-a")!
    const valid = { id: "queued-valid", content: "valid", createdAt: 1 }
    const quarantined = { id: "queued-quarantined", content: "quarantined", createdAt: 2 }
    const malformed = { id: "queued-malformed", content: "malformed", createdAt: "not-a-time" }
    const extraFieldKey = `${getMessageQueueKey(quarantinedTarget)}\nextra`

    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [getMessageQueueKey(validTarget)]: [null, valid, malformed],
        [getMessageQueueKey(quarantinedTarget)]: null,
        "not-an-array": { id: "not-a-queue" },
        [extraFieldKey]: [quarantined, null],
      },
      quarantinedLegacyMessages: {
        "already-quarantined": null,
        "valid-quarantine": [null, quarantined],
      },
    }, 3)

    expect(migrated.queuedMessages).toEqual({ [getMessageQueueKey(validTarget)]: [valid] })
    expect(migrated.quarantinedLegacyMessages).toEqual({
      "valid-quarantine": [quarantined],
      [extraFieldKey]: [quarantined],
    })
  })

  test("caps merged aliased queues at the newest 20 messages in persisted FIFO order", () => {
    const target = createMessageQueueTarget("session-1", "C:/Repo", "runtime-a")!
    const canonicalKey = getMessageQueueKey(target)
    const aliasedKey = ["runtime-a", "c:\\Repo\\", "session-1"].join("\n")
    const aliasedMessages = Array.from({ length: 25 }, (_, index) => ({
      id: `queued-alias-${index}`,
      content: `alias-${index}`,
      createdAt: index,
      contextClaimed: index % 2 === 0,
      additionalParts: [{ text: `alias-context-${index}`, synthetic: true }],
      sendConfig: { providerID: `alias-provider-${index}`, modelID: `alias-model-${index}` },
    }))
    const canonicalMessages = Array.from({ length: 15 }, (_, index) => ({
      id: `queued-canonical-${index}`,
      content: `canonical-${index}`,
      createdAt: index + 25,
      contextClaimed: true,
      additionalParts: [{ text: `context-${index}`, synthetic: true }],
      sendConfig: { providerID: `provider-${index}`, modelID: `model-${index}` },
    }))

    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [aliasedKey]: aliasedMessages,
        [canonicalKey]: canonicalMessages,
      },
    }, 2)

    expect(migrated.queuedMessages?.[canonicalKey]).toEqual([
      ...aliasedMessages.slice(-5),
      ...canonicalMessages,
    ])
    expect(migrated.queuedMessages?.[canonicalKey]).toHaveLength(20)
    expect(migrated.queuedMessages?.[canonicalKey]?.at(-1)).toEqual(canonicalMessages.at(-1))
  })

  test("migrates old UNC queue keys to the canonical target", () => {
    const target = createMessageQueueTarget("session-unc", "//Server/Share/Repo", "runtime-a")!
    const aliasKey = ["runtime-a", "\\\\SERVER\\Share\\Repo\\", "session-unc"].join("\n")
    const queued = { id: "queued-unc", content: "UNC queue", createdAt: 1 }

    const migrated = migrateMessageQueueState({
      queuedMessages: { [aliasKey]: [queued] },
    }, 2)

    expect(migrated.queuedMessages).toEqual({ [getMessageQueueKey(target)]: [queued] })
  })

  test("keeps POSIX case variants in separate persisted queues", () => {
    const upper = createMessageQueueTarget("session-posix", "/Repo", "runtime-a")!
    const lower = createMessageQueueTarget("session-posix", "/repo", "runtime-a")!
    const upperMessage = { id: "queued-upper", content: "upper", createdAt: 1 }
    const lowerMessage = { id: "queued-lower", content: "lower", createdAt: 2 }

    const migrated = migrateMessageQueueState({
      queuedMessages: {
        [getMessageQueueKey(upper)]: [upperMessage],
        [getMessageQueueKey(lower)]: [lowerMessage],
      },
    }, 2)

    expect(migrated.queuedMessages).toEqual({
      [getMessageQueueKey(upper)]: [upperMessage],
      [getMessageQueueKey(lower)]: [lowerMessage],
    })
  })

  test("canonicalizes and merges composite keys in quarantined state while retaining legacy keys", () => {
    const target = createMessageQueueTarget("session-1", "C:/Repo", "runtime-a")!
    const canonicalKey = getMessageQueueKey(target)
    const aliasedKey = ["runtime-a", "C:\\repo", "session-1"].join("\n")
    const quarantined = { id: "quarantined", content: "quarantined", createdAt: 1 }
    const aliased = { id: "aliased", content: "aliased", createdAt: 2 }
    const legacy = { id: "legacy", content: "legacy", createdAt: 3 }

    const migrated = migrateMessageQueueState({
      quarantinedLegacyMessages: {
        [canonicalKey]: [quarantined],
        [aliasedKey]: [aliased],
        "session-legacy": [legacy],
      },
    }, 2)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages).toEqual({
      [canonicalKey]: [quarantined, aliased],
      "session-legacy": [legacy],
    })
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
      quarantinedLegacyMessages: {
        "session-1": [{ id: "queued-0", content: "already quarantined", createdAt: 0 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.map((item) => item.content)).toEqual([
      "already quarantined",
      "legacy",
    ])
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

describe("main-session send disposition", () => {
  test("normalizes all legacy follow-up values to queue", () => {
    expect(normalizeFollowUpBehavior("steer")).toBe("queue")
    expect(normalizeFollowUpBehavior("immediate")).toBe("queue")
    expect(normalizeFollowUpBehavior(undefined, false)).toBe("queue")
    expect(normalizeFollowUpBehavior(undefined, true)).toBe("queue")
  })

  test("queues busy composer submissions, including dictation and preset/direct submit", () => {
    const busyComposer = {
      intent: "composer" as const,
      hasMainSession: true,
      isBtwActive: false,
      isBusy: true,
      canQueue: true,
    }
    expect(resolveMainSessionSendDisposition(busyComposer)).toBe("queue")
    expect(resolveMainSessionSendDisposition({ ...busyComposer })).toBe("queue")
  })

  test("keeps idle composer submissions on the direct-send path", () => {
    expect(resolveMainSessionSendDisposition({
      intent: "composer",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
    })).toBe("send")
  })

  test("preserves a queued chip when busy starts after it rendered idle", () => {
    const rendered = resolveMainSessionSendDisposition({
      intent: "queued",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
    })
    const clicked = resolveMainSessionSendDisposition({
      intent: "queued",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: true,
      canQueue: true,
    })

    expect(rendered).toBe("send")
    expect(clicked).toBe("preserve-queued")
  })

  test("defers composer input while a queued send is in flight", () => {
    expect(resolveMainSessionSendDisposition({
      intent: "composer",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
      hasQueuedMessageInFlight: true,
    })).toBe("queue")
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first, second] = useMessageQueueStore.getState().getQueueForTarget(target)

    expect(isQueueMessageDispatchable([first, second], [], second.id)).toBe(false)
    expect(useMessageQueueStore.getState().markSending(target, second.id)).toBe(false)

    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(true)
    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(false)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(0)

    expect(useMessageQueueStore.getState().getQueueDispatchState(target)).toEqual({
      head: first,
      sendingIds: [first.id],
    })

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
    expect(useMessageQueueStore.getState().markSending(target, inFlight.id)).toBe(true)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("restores exact entries after a merged composer send fails", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    const store = useMessageQueueStore.getState()
    const first = {
      content: "first",
      capturedContext: [{ text: "first context", synthetic: true }],
      additionalParts: [{ text: "first context", synthetic: true }],
      contextClaimed: true,
      sendConfig: { providerID: "provider-1", modelID: "model-1", agent: "agent-1", variant: "variant-1" },
    }
    const second = {
      content: "second",
      capturedContext: [{ text: "second context", synthetic: true }],
      additionalParts: [{ text: "second context", synthetic: true }],
      contextClaimed: true,
      sendConfig: { providerID: "provider-2", modelID: "model-2", agent: "agent-2", variant: "variant-2" },
    }
    store.addToQueue(target, first)
    store.addToQueue(target, second)
    const beforeSend = store.getQueueForTarget(target)

    const guard = store.getQueueRestorationGuard(target)
    const removed = store.clearQueue(target)
    expect(removed).toEqual(beforeSend)
    expect(store.getQueueForTarget(target)).toEqual([])

    // The normal composer send restores these entries from its rejection path.
    store.restoreQueue(target, removed, guard)
    expect(store.getQueueForTarget(target)).toEqual(beforeSend)
  })

  test("restores merged entries behind an in-flight item and ahead of newer queue additions", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight", sendConfig: { providerID: "provider-1", modelID: "model-1" } })
    store.addToQueue(target, { content: "merged", sendConfig: { providerID: "provider-2", modelID: "model-2" } })
    const [inFlight, merged] = store.getQueueForTarget(target)
    if (!inFlight || !merged) throw new Error("queue items were not created")
    store.markSending(target, inFlight.id)

    const guard = store.getQueueRestorationGuard(target)
    const removed = store.clearQueue(target)
    store.addToQueue(target, { content: "newer" })
    store.restoreQueue(target, removed, guard)
    const newer = store.getQueueForTarget(target).find((message) => message.content === "newer")
    if (!newer) throw new Error("newer queue item was not created")

    expect(store.getQueueForTarget(target).map((message) => message.id)).toEqual([
      inFlight.id,
      merged.id,
      newer.id,
    ])
    expect(store.getQueueForTarget(target).map((message) => message.content)).toEqual([
      "in flight",
      "merged",
      "newer",
    ])
    expect(store.getQueueDispatchState(target).sendingIds).toEqual([inFlight.id])
  })

  test("keeps newer additions when restoring a merged batch over queue capacity", () => {
    const target = createMessageQueueTarget("session-1", "/repo", getRuntimeKey())!
    const store = useMessageQueueStore.getState()
    for (let index = 0; index < 20; index += 1) {
      store.addToQueue(target, { content: index === 0 ? "in flight" : `merged-${index}` })
    }

    const [inFlight] = store.getQueueForTarget(target)
    if (!inFlight) throw new Error("queue head was not created")
    expect(store.markSending(target, inFlight.id)).toBe(true)

    const guard = store.getQueueRestorationGuard(target)
    const removed = store.clearQueue(target)
    for (let index = 0; index < 5; index += 1) {
      store.addToQueue(target, { content: `newer-${index}` })
    }

    store.restoreQueue(target, removed, guard)

    expect(store.getQueueForTarget(target).map((message) => message.content)).toEqual([
      "in flight",
      ...Array.from({ length: 14 }, (_, index) => `merged-${index + 6}`),
      "newer-0",
      "newer-1",
      "newer-2",
      "newer-3",
      "newer-4",
    ])
    expect(store.getQueueForTarget(target)).toHaveLength(20)
    expect(store.getQueueDispatchState(target).sendingIds).toEqual([inFlight.id])
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test("clearAllQueues drops non-in-flight entries without releasing a send barrier", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "later" })
    const [inFlight, later] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!inFlight || !later) throw new Error("queue items were not created")

    expect(store.markSending(target, inFlight.id)).toBe(true)
    store.clearAllQueues()

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([inFlight])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([inFlight.id])
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toEqual([])
    expect(store.markSending(target, later.id)).toBe(false)

    store.completeSending(target, inFlight.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([])
  })

  test("clearAllQueues leaves no queue or claims when nothing is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearAllQueues()

    expect(useMessageQueueStore.getState().queuedMessages).toEqual({})
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("keeps the in-flight head when queue capacity trims older items", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const first = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    if (!first) throw new Error("queue head was not created")
    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(true)

    useMessageQueueStore.getState().addToQueue(target, { content: "newest message" })

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.id).toBe(first.id)
    expect(queue[0]?.content).toBe("message-0")
    expect(queue.at(-1)?.content).toBe("newest message")
  })

  test("does not reorder a target while a queued send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "head" })
    useMessageQueueStore.getState().addToQueue(target, { content: "tail" })
    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const head = queue[0]
    const tail = queue[1]
    if (!head || !tail) throw new Error("queue items were not created")

    expect(useMessageQueueStore.getState().markSending(target, head.id)).toBe(true)
    useMessageQueueStore.getState().reorderQueue(target, tail.id, head.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.content)).toEqual([
      "head",
      "tail",
    ])
  })

  test("does not remove or pop the in-flight item, but preserves non-in-flight queue edits", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "head" })
    store.addToQueue(target, { content: "tail" })
    const [head, tail] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!head || !tail) throw new Error("queue items were not created")

    expect(useMessageQueueStore.getState().markSending(target, head.id)).toBe(true)
    store.removeFromQueue(target, head.id)
    expect(store.popToInput(target, head.id)).toBeNull()
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.id)).toEqual([head.id, tail.id])

    store.removeFromQueue(target, tail.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.id)).toEqual([head.id])
  })

  test("allows remove and pop for non-in-flight items", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "remove me" })
    store.addToQueue(target, { content: "edit me" })
    const [remove, pop] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!remove || !pop) throw new Error("queue items were not created")

    store.removeFromQueue(target, remove.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([pop])
    expect(store.popToInput(target, pop.id)).toEqual(pop)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
  })

  test("completes an in-flight send by removing its item and claim atomically", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "head" })
    store.addToQueue(target, { content: "tail" })
    const [head, tail] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!head || !tail) throw new Error("queue items were not created")

    expect(store.markSending(target, head.id)).toBe(true)
    store.completeSending(target, head.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([tail])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([])
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toEqual([tail])
  })
})
