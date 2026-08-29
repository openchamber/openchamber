import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  normalizePersistedQueueMessages,
  parseMessageQueueKey,
  useMessageQueueStore,
} from "./messageQueueStore"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {}, durableTombstones: {} })
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

  test("caps mixed admission states without reordering the queue", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "admitted-1", admissionState: "admitted" })
    store.addToQueue(target, { content: "local-1", admissionState: "local" })
    store.addToQueue(target, { content: "pending-1", admissionState: "pending-admission" })
    store.addToQueue(target, { content: "local-2", admissionState: "local" })
    store.addToQueue(target, { content: "admitted-2", admissionState: "admitted" })

    expect(store.getQueueForTarget(target).map((message) => message.content)).toEqual([
      "admitted-1", "local-1", "pending-1", "local-2", "admitted-2",
    ])
  })

  test("preserves mixed order when admitting a queued message and keeps state caps", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    const admittedIds = Array.from({ length: 21 }, (_, index) => store.addToQueue(target, {
      content: `admitted-${index}`, admissionState: "admitted",
    }))
    const localId = store.addToQueue(target, { content: "local", admissionState: "local" })
    const pendingId = store.addToQueue(target, { content: "pending", admissionState: "pending-admission" })
    const targetId = store.addToQueue(target, { content: "to-admit", admissionState: "pending-admission" })

    store.markAdmissionAdmitted(target, targetId, { admittedSeq: 100, timeCreated: 1 })

    const queue = store.getQueueForTarget(target)
    expect(queue.map((message) => message.id)).toEqual([
      ...admittedIds.slice(2), localId, pendingId, targetId,
    ])
    expect(queue.filter((message) => message.admissionState === "admitted")).toHaveLength(20)
    expect(queue.filter((message) => message.admissionState === "pending-admission")).toHaveLength(1)
    expect(queue.filter((message) => message.admissionState === "local")).toHaveLength(1)
  })

  test("keeps a fresh pending target when the 51-target cap evicts an older target", () => {
    const targets = Array.from({ length: 50 }, (_, index) => createMessageQueueTarget(`session-${index}`, "/repo", "runtime-a")!)
    for (const target of targets) useMessageQueueStore.getState().addToQueue(target, { content: target.sessionId })
    const fresh = createMessageQueueTarget("fresh", "/repo", "runtime-a")!
    const freshId = useMessageQueueStore.getState().addToQueue(fresh, { content: "keep", admissionState: "pending-admission" })

    expect(useMessageQueueStore.getState().getQueueForTarget(fresh).map((message) => message.id)).toEqual([freshId])
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(50)
    expect(useMessageQueueStore.getState().getQueueForTarget(targets[0])).toEqual([])
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

  test("admitted and pending messages are never locally sendable or cleared", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    const pending = store.addToQueue(target, { content: "pending", admissionState: 'pending-admission' })
    const admitted = store.addToQueue(target, { content: "admitted", admissionState: 'admitted' })
    expect(store.getSendableQueue(target)).toHaveLength(0)
    store.clearQueue(target)
    const remaining = store.getQueueForTarget(target)
    expect(remaining.map((message) => message.id)).toEqual([pending, admitted])
  })

  test("v2 migration marks legacy queued items local", () => {
    const migrated = migrateMessageQueueState({ queuedMessages: { key: [{ id: 'q', content: 'text', createdAt: 1 }] } }, 2)
    expect(migrated.queuedMessages?.key?.[0]?.admissionState).toBe('local')
  })

  test("migration does not turn an interrupted admission into a resend", () => {
    const attachment = { id: 'file', file: new File([], 'a.txt'), dataUrl: 'data:text/plain;base64,a', mimeType: 'text/plain', filename: 'a.txt', size: 1, source: 'local' as const }
    const migrated = migrateMessageQueueState({ queuedMessages: { key: [{ id: 'q', content: 'text', createdAt: 1, admissionState: 'pending-admission', attachments: [attachment] }] } }, 3)
    expect(migrated.queuedMessages?.key?.[0]?.admissionState).toBe('admission-unknown')
    expect(migrated.queuedMessages?.key?.[0]?.attachments).toEqual([attachment])
  })

  test("same-version hydration normalizes pending items and expires old admitted history", () => {
    const attachment = { id: 'pending-file', file: new File([], 'pending.txt'), dataUrl: 'data:text/plain;base64,p', mimeType: 'text/plain', filename: 'pending.txt', size: 1, source: 'local' as const }
    const hydrated = normalizePersistedQueueMessages({ key: [
      { id: 'pending', content: 'keep', createdAt: Date.now(), admissionState: 'pending-admission', attachments: [attachment] },
      { id: 'unknown', content: 'recover', createdAt: Date.now(), admissionState: 'admission-unknown', attachments: [attachment] },
      { id: 'old', content: 'drop', createdAt: 1, admissionState: 'admitted', attachments: [attachment] },
    ]})
    expect(hydrated.key?.map((message) => [message.id, message.admissionState])).toEqual([
      ['pending', 'admission-unknown'],
      ['unknown', 'admission-unknown'],
    ])
    expect(hydrated.key?.find((message) => message.id === 'pending')?.attachments).toEqual([attachment])
    expect(hydrated.key?.find((message) => message.id === 'unknown')?.attachments).toEqual([attachment])
  })

  test("removes an empty queue after dismissing unknown admission", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "unknown", admissionState: "admission-unknown" })
    useMessageQueueStore.getState().dismissAdmissionUnknown(target, useMessageQueueStore.getState().getQueueForTarget(target)[0]!.id)
    expect(useMessageQueueStore.getState().queuedMessages).toEqual({})
  })

  test("removes an empty queue after recovering unknown admission", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "failed", admissionState: "admission-failed" })
    const id = useMessageQueueStore.getState().getQueueForTarget(target)[0]!.id
    expect(useMessageQueueStore.getState().recoverAdmissionToInput(target, id)?.content).toBe("failed")
    expect(useMessageQueueStore.getState().queuedMessages).toEqual({})
  })

  test("refreshing a tombstone makes it the newest capped entry", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    for (let index = 0; index < 20; index += 1) store.removeDurableAdmission(target, `message-${index}`, index)
    store.removeDurableAdmission(target, "message-0", 100)
    store.removeDurableAdmission(target, "message-new", 101)
    const tombstones = useMessageQueueStore.getState().durableTombstones[Object.keys(useMessageQueueStore.getState().durableTombstones)[0]!]
    expect(tombstones?.["message-0"]).toBe(100)
    expect(Object.keys(tombstones ?? {})).toHaveLength(20)
    expect(tombstones?.["message-1"]).toBe(undefined)
  })

  test("keeps the updated target when capping 51 durable tombstone targets", () => {
    const targets = Array.from({ length: 51 }, (_, index) => createMessageQueueTarget(`session-${index}`, "/repo", "runtime-a")!)
    const tombstones = Object.fromEntries(targets.map((target, index) => [getMessageQueueKey(target), { [`message-${index}`]: index }]))
    useMessageQueueStore.setState({ durableTombstones: tombstones })

    useMessageQueueStore.getState().removeDurableAdmission(targets[0]!, "message-current", 100)

    const durableTombstones = useMessageQueueStore.getState().durableTombstones
    expect(Object.keys(durableTombstones)).toHaveLength(50)
    expect(durableTombstones[getMessageQueueKey(targets[0]!)]?.["message-current"]).toBe(100)
    expect(durableTombstones[getMessageQueueKey(targets[1]!) ]).toBe(undefined)
  })

  test("hydration strips attachment payloads from admitted history", () => {
    const attachment = { id: 'server-file', file: new File([], 'server.txt'), dataUrl: 'data:text/plain;base64,s', mimeType: 'text/plain', filename: 'server.txt', size: 1, source: 'local' as const }
    const hydrated = normalizePersistedQueueMessages({ key: [
      { id: 'admitted', content: 'server-owned', createdAt: Date.now(), admissionState: 'admitted', attachments: [attachment] },
    ]})
    expect(hydrated.key?.[0]?.attachments).toBe(undefined)
  })

  test("bounds admitted history without evicting recoverable messages", () => {
    const recoverable = Array.from({ length: 20 }, (_, index) => ({
      id: `local-${index}`, content: `local-${index}`, createdAt: Date.now(), admissionState: 'admission-failed' as const,
    }))
    const admitted = Array.from({ length: 30 }, (_, index) => ({
      id: `admitted-${index}`, content: `admitted-${index}`, createdAt: Date.now(), admissionState: 'admitted' as const,
    }))
    const normalized = normalizePersistedQueueMessages({ key: [...recoverable, ...admitted] }).key ?? []
    expect(normalized.filter((message) => message.admissionState === 'admission-failed')).toHaveLength(20)
    expect(normalized.filter((message) => message.admissionState === 'admitted')).toHaveLength(20)
  })

  test("settling B never changes pending A data", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const attachment = { id: 'a-file', file: new File([], 'a.txt'), dataUrl: 'data:text/plain;base64,a', mimeType: 'text/plain', filename: 'a.txt', size: 1, source: 'local' as const }
    const store = useMessageQueueStore.getState()
    const a = store.addToQueue(target, { content: 'A', admissionState: 'pending-admission', clientMessageId: 'msg_a', attachments: [attachment], sendConfig: { providerID: 'p', modelID: 'm' } })
    const b = store.addToQueue(target, { content: 'B', admissionState: 'pending-admission', clientMessageId: 'msg_b', attachments: [attachment], sendConfig: { providerID: 'p', modelID: 'm' } })

    useMessageQueueStore.getState().markAdmissionLocal(target, b)
    let queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingA = queue.find((message) => message.id === a)
    expect(pendingA?.admissionState).toBe('pending-admission')
    expect(pendingA?.attachments).toEqual([attachment])
    expect(pendingA?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })

    useMessageQueueStore.getState().markAdmissionLocal(target, a)
    expect(useMessageQueueStore.getState().getSendableQueue(target).map((message) => message.id)).toEqual([a, b])
    useMessageQueueStore.getState().markAdmissionPending(target, a, 'msg_a')

    useMessageQueueStore.getState().markAdmissionPending(target, b, 'msg_b')
    useMessageQueueStore.getState().markAdmissionFailed(target, b)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingAAfterFailedB = queue.find((message) => message.id === a)
    expect(pendingAAfterFailedB?.admissionState).toBe('pending-admission')
    expect(pendingAAfterFailedB?.attachments).toEqual([attachment])
    expect(pendingAAfterFailedB?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })
    expect(queue.find((message) => message.id === b)?.admissionState).toBe('admission-failed')

    useMessageQueueStore.getState().markAdmissionPending(target, b, 'msg_b')
    useMessageQueueStore.getState().markAdmissionUnknown(target, b)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const pendingAAfterUnknownB = queue.find((message) => message.id === a)
    expect(pendingAAfterUnknownB?.admissionState).toBe('pending-admission')
    expect(pendingAAfterUnknownB?.attachments).toEqual([attachment])
    expect(pendingAAfterUnknownB?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })
    expect(queue.find((message) => message.id === b)?.attachments).toEqual([attachment])

    useMessageQueueStore.getState().markAdmissionLocal(target, a)
    queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue.map((message) => message.id)).toEqual([a, b])
    expect(queue.map((message) => message.admissionState)).toEqual(['local', 'admission-unknown'])
    expect(queue.find((message) => message.id === a)?.attachments).toEqual([attachment])
    expect(queue.find((message) => message.id === a)?.sendConfig).toEqual({ providerID: 'p', modelID: 'm' })
  })

  test("marking admission on a missing target does not create an empty queue", () => {
    const target = createMessageQueueTarget("missing", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()

    store.markAdmissionPending(target, "missing-message", "missing-client")
    store.markAdmissionLocal(target, "missing-message")
    store.markAdmissionAdmitted(target, "missing-message", { admittedSeq: 1, timeCreated: 1 })
    store.markAdmissionFailed(target, "missing-message")
    store.markAdmissionUnknown(target, "missing-message")

    expect(useMessageQueueStore.getState().queuedMessages).toEqual({})
  })
})
