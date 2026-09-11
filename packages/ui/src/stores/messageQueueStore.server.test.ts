import { beforeEach, describe, expect, mock, test } from "bun:test"
import { selectInputHistoryEntries, useInputHistoryStore } from "./useInputHistoryStore"
import type { AttachedFile } from "./types/sessionTypes"
import type { MessageQueueUpdatedEvent } from "./messageQueueStore"
import type { RuntimeFetchOptions } from "@/lib/runtime-fetch"

type FetchCall = { path: string; method: string; body: ReturnType<typeof JSON.parse>; runtimeTarget?: RuntimeFetchOptions["runtimeTarget"] }
let calls: FetchCall[] = []
let activeRuntimeKey = "runtime-a"
let activeRuntimeBaseUrl = "http://runtime-a.test"
let respond: (call: FetchCall) => Response | Promise<Response> = () => new Response("{}", { status: 200 })

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (path: string, init?: RuntimeFetchOptions) => {
    const call: FetchCall = {
      path,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    if (init?.runtimeTarget) call.runtimeTarget = init.runtimeTarget
    calls.push(call)
    return respond(call)
  },
}))
const desktop = await import("@/lib/desktop")
mock.module("@/lib/desktop", () => ({ ...desktop, isVSCodeRuntime: () => false }))
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => activeRuntimeKey, getRuntimeApiBaseUrl: () => activeRuntimeBaseUrl }))
mock.module("@/lib/persistence", () => ({ loadDesktopSettings: async () => ({}), updateDesktopSettings: async () => undefined }))

const HOLD_IDENTITY_STORAGE_KEY = "openchamber-message-queue-hold.v1"

const createFakeStorage = (): Storage => {
  const store = new Map<string, string>()
  const storage: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
  return storage
}

// Hold identity is persisted per runtime; tests control that storage directly
// so a fresh module instance can be exercised as a page reload.
const realSafeStorage = await import("./utils/safeStorage")
let holdIdentityStorage = createFakeStorage()
mock.module("./utils/safeStorage", () => ({
  ...realSafeStorage,
  getSafeStorage: () => holdIdentityStorage,
}))

const importFreshMessageQueueStore = async (): Promise<typeof import("./messageQueueStore")> => (
  import(`./messageQueueStore.ts?test=${Date.now()}-${Math.random()}`)
)

const {
  applyMessageQueueUpdatedEvent,
  createMessageQueueTarget,
  getMessageQueueKey,
  migrateMessageQueueState,
  useMessageQueueStore,
} = await import("./messageQueueStore")

type ServerItem = MessageQueueUpdatedEvent["properties"]["session"]["items"][number]
type ServerSession = MessageQueueUpdatedEvent["properties"]["session"]

type ServerReply = {
  revision?: number
  complete?: boolean
  session?: ServerSession
  sessions?: ServerSession[]
  sessionLifecycles?: Record<string, { directory?: string; generation: number; deleted?: boolean; restoreRequiresReceipt?: boolean }>
  itemId?: string
  item?: ServerItem
  items?: ServerItem[]
  generation?: number
  held?: boolean
  expiresAt?: number | null
  sequence?: number
  acknowledged?: boolean
}

const json = (value: ServerReply, status = 200) => new Response(JSON.stringify(value), { status })

const deferredResponse = () => {
  let complete: ((response: Response) => void) | undefined
  const promise = new Promise<Response>((resolve) => { complete = resolve })
  return { promise, resolve: (response: Response) => {
    if (!complete) throw new Error("Deferred response was not initialized")
    complete(response)
  } }
}

const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
const key = getMessageQueueKey(target)

const serverItem = (id: string, content: string, extra: Partial<ServerItem> = {}): ServerItem => ({
  id,
  createdAt: 1,
  content,
  text: content,
  attachments: [],
  sendConfig: { providerID: "p", modelID: "m" },
  ...extra,
})

const issueMetadata = { openchamberContext: { kind: "github-issue" as const, number: 3, title: "Bug", url: "https://x/issues/3" } }

const session = (items: ServerItem[], sendingId: string | null = null): ServerSession => ({
  sessionId: "session-1",
  directory: "/repo",
  items,
  sendingId,
})

const updated = (revision: number, updatedSession: ServerSession): MessageQueueUpdatedEvent => ({
  type: "openchamber:message-queue.updated",
  properties: { revision, session: updatedSession },
})

const attachment: AttachedFile = {
  id: "att-1",
  file: new File(["hi"], "note.txt", { type: "text/plain" }),
  dataUrl: "data:text/plain;base64,aGk=",
  mimeType: "text/plain",
  filename: "note.txt",
  size: 2,
  source: "local",
}

beforeEach(() => {
  holdIdentityStorage = createFakeStorage()
  useMessageQueueStore.getState().resetForRuntimeSwitch(activeRuntimeKey)
  activeRuntimeKey = "runtime-a"
  activeRuntimeBaseUrl = "http://runtime-a.test"
  useInputHistoryStore.setState({ globalBuckets: {}, sessionBuckets: {} })
  calls = []
  respond = () => json({ revision: 1, session: session([]) })
  useMessageQueueStore.getState().resetForRuntimeSwitch(activeRuntimeKey)
  // Forgetting also drops the revision guard, so each test starts unordered.
  useMessageQueueStore.getState().forgetQueue(target)
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, pendingLegacyMessages: {}, sendingIds: {}, pendingServerRestores: {}, pendingServerTakes: {}, pendingServerTakeAcks: {}, pendingServerEnqueues: {}, takenServerOperations: {}, queueDeletionGenerations: {}, retryPendingIds: {} })
})

describe("server-owned message queue", () => {
  test("keeps a legacy message without sendConfig until a valid selection exists", async () => {
    activeRuntimeKey = "runtime-legacy-missing-config"
    const legacyTarget = createMessageQueueTarget("session-legacy-missing-config", "/repo", activeRuntimeKey)!
    const legacyKey = getMessageQueueKey(legacyTarget)
    const legacyMessage = { id: "legacy-no-config", content: "needs a model", text: "needs a model", createdAt: 1 }
    useMessageQueueStore.setState({ queuedMessages: { [legacyKey]: [legacyMessage] } })
    respond = () => json({ revision: 1, sessions: [] })

    await useMessageQueueStore.getState().hydrate()

    expect(calls.map((call) => call.method)).toEqual(["GET"])
    expect(useMessageQueueStore.getState().queuedMessages[legacyKey]).toEqual([legacyMessage])
    expect(useMessageQueueStore.getState().pendingLegacyMessages[legacyKey]).toEqual([legacyMessage])
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
  })

  test("hydrate reads the server before uploading messages queued by an older build", async () => {
    useMessageQueueStore.setState({
      queuedMessages: {
        [key]: [{ id: "local-1", content: "from before", text: "from before", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }],
      },
    })
    respond = (call) => (call.method === "POST"
      ? json({ revision: 2, session: session([serverItem("q1", "from before")]) })
      : json({ revision: 1, sessions: [session([])] }))
    await useMessageQueueStore.getState().hydrate()

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/message-queue",
    })
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/message-queue/sessions/session-1/items",
      body: { directory: "/repo", item: { content: "from before", text: "from before", attachments: [], context: [], sendConfig: { providerID: "p", modelID: "m" } } },
    })
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
  })

  test("removes a legacy message deleted while its migration POST is in flight", async () => {
    activeRuntimeKey = "runtime-enqueue-race"
    const migrationTarget = createMessageQueueTarget("session-enqueue-race", "/repo", activeRuntimeKey)!
    const migrationKey = getMessageQueueKey(migrationTarget)
    const message = { id: "legacy-race", content: "remove during migration", text: "remove during migration", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }
    useMessageQueueStore.setState({ queuedMessages: { [migrationKey]: [message] } })
    let resolveEnqueue: ((response: Response) => void) | undefined
    respond = (call) => {
      if (call.method === "GET") return json({ revision: 1, sessions: [session([])] })
      if (call.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveEnqueue = resolve
        })
      }
      if (call.method === "DELETE") return json({ revision: 2, session: { ...session([]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory } })
      return json({ revision: 3, sessions: [] })
    }

    const hydrating = useMessageQueueStore.getState().hydrate()
    await Promise.resolve()
    expect(calls[0]?.method).toBe("GET")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[1]?.method).toBe("POST")
    expect(useMessageQueueStore.getState().pendingServerEnqueues).not.toEqual({})

    expect(useMessageQueueStore.getState().removeFromQueue(migrationTarget, message.id)?.id).toBe(message.id)
    resolveEnqueue?.(json({
      revision: 1,
      itemId: "accepted-race",
      session: { ...session([serverItem("accepted-race", message.content)]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory },
    }))
    await hydrating

    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "DELETE"])
    expect(calls[2]?.path).toBe(`/api/message-queue/sessions/${migrationTarget.sessionId}/items/accepted-race`)
    expect(useMessageQueueStore.getState().queuedMessages[migrationKey]).toBe(undefined)
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
  })

  test("keeps migration item cleanup ahead of a queued clear", async () => {
    activeRuntimeKey = "runtime-migration-clear-race"
    const migrationTarget = createMessageQueueTarget("session-migration-clear-race", "/repo", activeRuntimeKey)!
    const migrationKey = getMessageQueueKey(migrationTarget)
    const message = { id: "legacy-clear", content: "clear during migration", text: "clear during migration", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }
    const post = deferredResponse()
    const accepted = serverItem("accepted-clear-migration", message.content)
    useMessageQueueStore.setState({ queuedMessages: { [migrationKey]: [message] } })
    respond = (call) => {
      if (call.method === "GET") return json({ revision: 1, sessions: [{ ...session([]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory }] })
      if (call.method === "POST") return post.promise
      if (call.path.endsWith(`/items/${accepted.id}`)) return json({ revision: 2, session: { ...session([]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory } })
      if (call.method === "DELETE") return json({ revision: 3, session: { ...session([]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory } })
      return json({ revision: 4, sessions: [] })
    }

    const hydrating = useMessageQueueStore.getState().hydrate()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"])

    useMessageQueueStore.getState().clearQueue(migrationTarget)
    post.resolve(json({
      revision: 1,
      itemId: accepted.id,
      session: { ...session([accepted]), sessionId: migrationTarget.sessionId, directory: migrationTarget.directory },
    }))
    await hydrating

    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "DELETE", "DELETE"])
    expect(calls[2]?.path).toBe(`/api/message-queue/sessions/${migrationTarget.sessionId}/items/${accepted.id}`)
    expect(calls[3]?.path).toBe(`/api/message-queue/sessions/${migrationTarget.sessionId}`)
    expect(useMessageQueueStore.getState().queuedMessages[migrationKey]).toBe(undefined)
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
  })

  test("retries a failed legacy upload on a later hydration", async () => {
    activeRuntimeKey = "runtime-migration-retry"
    const retryTarget = createMessageQueueTarget("session-migration-retry", "/repo", activeRuntimeKey)!
    const retryKey = getMessageQueueKey(retryTarget)
    let postAttempts = 0
    const retrySession = (items: ServerItem[]): ServerSession => ({ ...session(items), sessionId: retryTarget.sessionId })
    useMessageQueueStore.setState({
      queuedMessages: {
        [retryKey]: [{ id: "local-retry", content: "retry me", text: "retry me", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }],
      },
    })
    respond = (call) => {
      if (call.method === "POST") {
        postAttempts += 1
        return postAttempts === 1
          ? json({}, 500)
          : json({ revision: 2, session: retrySession([serverItem("srv-retry", "retry me")]) })
      }
      return json({ revision: postAttempts === 1 ? 1 : 2, sessions: [retrySession(postAttempts === 1 ? [] : [serverItem("srv-retry", "retry me")])] })
    }

    await useMessageQueueStore.getState().hydrate()
    expect(postAttempts).toBe(1)
    expect(Object.keys(useMessageQueueStore.getState().pendingServerEnqueues)).toHaveLength(1)

    await useMessageQueueStore.getState().hydrate()
    expect(postAttempts).toBe(2)
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
    expect(useMessageQueueStore.getState().queuedMessages[retryKey]?.map((message) => message.id)).toEqual(["srv-retry"])
  })

  test("hydrate replaces the runtime's projection with the server queue", async () => {
    respond = () => json({ revision: 3, sessions: [session([serverItem("q1", "hello")], "q1")] })
    await useMessageQueueStore.getState().hydrate()

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/message-queue"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["hello"])
    expect(useMessageQueueStore.getState().sendingIds[key]).toEqual(["q1"])
  })

  test("hydrate keeps a queue newer than its snapshot", async () => {
    applyMessageQueueUpdatedEvent(updated(10, session([serverItem("q1", "queued after the read started")])), "runtime-a")
    respond = () => json({ revision: 9, sessions: [] })
    await useMessageQueueStore.getState().hydrate()

    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
  })

  test("context-only queue previews survive authoritative snapshots", async () => {
    respond = () => json({ revision: 3, sessions: [session([serverItem("q1", "", { contextPreview: "Explain this quote" })])] })
    await useMessageQueueStore.getState().hydrate()
    const queued = useMessageQueueStore.getState().queuedMessages[key]?.[0]
    expect(queued?.contextPreview).toBe("Explain this quote")
    expect(queued?.content).toBe("")
    expect(queued?.context).toBeUndefined()
  })

  test("resync can establish the initial snapshot before bootstrap", async () => {
    activeRuntimeKey = "runtime-never-hydrated"
    respond = () => json({ revision: 1, sessions: [] })
    await useMessageQueueStore.getState().resync()
    expect(calls).toHaveLength(1)
  })

  test("a reconnect during the initial snapshot retains one trailing refresh", async () => {
    const first = deferredResponse()
    respond = () => calls.length === 1 ? first.promise : json({ revision: 12, sessions: [] })
    const bootstrap = useMessageQueueStore.getState().hydrate()
    const reconnect = useMessageQueueStore.getState().resync()
    const secondReconnect = useMessageQueueStore.getState().resync()
    expect(calls).toHaveLength(1)
    first.resolve(json({ revision: 10, sessions: [session([serverItem("q1", "delivered after snapshot")])] }))
    await Promise.all([bootstrap, reconnect, secondReconnect])
    expect(calls).toHaveLength(2)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined()
  })

  test("concurrent bootstrap and recovery migrate a legacy message only once", async () => {
    activeRuntimeKey = "runtime-legacy-recovery"
    const legacyTarget = createMessageQueueTarget("session-1", "/repo", activeRuntimeKey)
    if (!legacyTarget) throw new Error("Missing test target")
    const legacyKey = getMessageQueueKey(legacyTarget)
    useMessageQueueStore.setState({ queuedMessages: { [legacyKey]: [{ id: "local", content: "legacy", text: "legacy", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }] } })
    const upload = deferredResponse()
    respond = (call) => call.method === "POST" ? upload.promise : json({ revision: 2, sessions: [] })
    const bootstrap = useMessageQueueStore.getState().hydrate()
    const recovery = useMessageQueueStore.getState().resync()
    upload.resolve(json({ revision: 2, session: session([]) }))
    await Promise.all([bootstrap, recovery])
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(useMessageQueueStore.getState().queuedMessages[legacyKey]).toBeUndefined()
  })

  test("an empty snapshot prevents delayed responses from resurrecting omitted queues", async () => {
    applyMessageQueueUpdatedEvent(updated(10, session([serverItem("q1", "queued")], "q1")), "runtime-a")
    respond = () => json({ revision: 12, sessions: [] })
    await useMessageQueueStore.getState().hydrate()
    applyMessageQueueUpdatedEvent(updated(11, session([serverItem("q1", "stale")], "q1")), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined()
    expect(useMessageQueueStore.getState().sendingIds[key]).toBeUndefined()
    const other = { ...session([serverItem("q2", "unseen stale")]), sessionId: "unseen" }
    applyMessageQueueUpdatedEvent(updated(11, other), "runtime-a")
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(0)
  })

  test("recovery demand survives a failed in-flight snapshot", async () => {
    const first = deferredResponse()
    applyMessageQueueUpdatedEvent(updated(10, session([serverItem("q1", "delivered")])), "runtime-a")
    respond = () => calls.length === 1 ? first.promise : json({ revision: 12, sessions: [] })
    const bootstrap = useMessageQueueStore.getState().hydrate()
    const recovery = useMessageQueueStore.getState().resync()
    first.resolve(new Response(null, { status: 503 }))
    await Promise.all([bootstrap, recovery])
    expect(calls).toHaveLength(2)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined()
  })

  test("returning to a runtime migrates its unattempted legacy messages without repeating the first upload", async () => {
    activeRuntimeKey = "runtime-partial-migration"
    const legacyTarget = createMessageQueueTarget("session-1", "/repo", activeRuntimeKey)
    if (!legacyTarget) throw new Error("Missing test target")
    const legacyKey = getMessageQueueKey(legacyTarget)
    useMessageQueueStore.setState({ queuedMessages: { [legacyKey]: ["first", "second"].map((id) => ({ id, content: id, text: id, createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } })) } })
    const first = deferredResponse()
    respond = (call) => call.method === "POST"
      ? calls.length === 1 ? first.promise : json({ revision: 2, session: session([]) })
      : json({ revision: 3, sessions: [] })
    const initial = useMessageQueueStore.getState().hydrate()
    useMessageQueueStore.getState().resetForRuntimeSwitch(activeRuntimeKey)
    activeRuntimeKey = "runtime-other"
    first.resolve(json({ revision: 1, session: session([]) }))
    await initial
    activeRuntimeKey = "runtime-partial-migration"
    await useMessageQueueStore.getState().hydrate()
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body.item.content)).toEqual(["first", "second"])
  })

  test("a failed refresh preserves the projection and a later recovery retries", async () => {
    applyMessageQueueUpdatedEvent(updated(10, session([serverItem("q1", "queued")])), "runtime-a")
    respond = () => new Response(null, { status: 503 })
    await expect(useMessageQueueStore.getState().resync()).rejects.toThrow()
    expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1)
    respond = () => json({ revision: 12, sessions: [] })
    await useMessageQueueStore.getState().resync()
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined()
  })

  test("a runtime switch rejects an old snapshot and its pending recovery", async () => {
    const old = deferredResponse()
    respond = () => old.promise
    const bootstrap = useMessageQueueStore.getState().hydrate()
    const recovery = useMessageQueueStore.getState().resync()
    useMessageQueueStore.getState().resetForRuntimeSwitch(activeRuntimeKey)
    activeRuntimeKey = "runtime-b"
    respond = () => json({ revision: 1, sessions: [] })
    await useMessageQueueStore.getState().hydrate()
    old.resolve(json({ revision: 99, sessions: [session([serverItem("q1", "old runtime")])] }))
    await Promise.all([bootstrap, recovery])
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  test("resync drops a queue the server no longer lists", async () => {
    respond = () => json({ revision: 3, sessions: [session([serverItem("q1", "queued")], "q1")] })
    await useMessageQueueStore.getState().hydrate()

    respond = () => json({ revision: 4, sessions: [] })
    await useMessageQueueStore.getState().resync()
  })

  test("hydrate clears an empty projection and adopts its lifecycle generation", async () => {
    useMessageQueueStore.setState({
      queuedMessages: { [key]: [{ id: "stale", content: "stale local projection", text: "stale local projection", createdAt: 1 }] },
      sendingIds: { [key]: ["stale"] },
    })
    respond = () => json({
      revision: 6,
       sessions: [{ sessionId: target.sessionId, directory: target.directory, items: [], sendingId: null, generation: 7 }],
       sessionLifecycles: {
         [target.sessionId]: { directory: target.directory, generation: 7, restoreRequiresReceipt: true },
       },
    })

    await useMessageQueueStore.getState().hydrate()

    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    expect(useMessageQueueStore.getState().sendingIds[key]).toBe(undefined)
    expect(useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory).generation).toBe(7)
    expect(useMessageQueueStore.getState().getQueueRestorationGuard(target).requiresReceipt).toBe(true)
  })

  test("keeps the previous projection when a successful response is explicitly partial", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "local", content: "keep local", text: "keep local", createdAt: 1 }] } })
    respond = () => json({ revision: 8, complete: false, sessions: [] })

    await useMessageQueueStore.getState().hydrate()

    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((item) => item.content)).toEqual(["keep local"])
  })

  test("keeps the previous projection when the authoritative snapshot fails", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "local", content: "keep after failure", text: "keep after failure", createdAt: 1 }] } })
    respond = () => json({}, 503)

    await expect(useMessageQueueStore.getState().hydrate()).rejects.toThrow()
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((item) => item.content)).toEqual(["keep after failure"])
  })

  test("hydrate clears a missing session only after a successful complete snapshot", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "stale", content: "stale local projection", text: "stale local projection", createdAt: 1 }] } })
    respond = () => json({ revision: 7, sessions: [] })

    await useMessageQueueStore.getState().hydrate()

    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("addToQueue shows the message at once and settles on the server's copy", async () => {
    respond = () => json({ revision: 5, session: session([serverItem("srv-1", "hi @reviewer", { agentMention: "reviewer" })]) })
    const pending = useMessageQueueStore.getState().addToQueue(target, {
      content: "hi @reviewer",
      text: "hi",
      agentMention: "reviewer",
      attachments: [attachment],
      sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    })
    expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1)
    await pending

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/message-queue/sessions/session-1/items",
      body: {
        directory: "/repo",
        item: {
          content: "hi @reviewer",
          text: "hi",
          agentMention: "reviewer",
          attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: attachment.dataUrl }],
          context: [],
          sendConfig: { providerID: "p", modelID: "m", agent: "build" },
        },
      },
    })
    expect(calls[0]?.body.idempotencyKey).toContain("session-1")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["srv-1"])
  })

  test("marks an accepted enqueue authoritative before a later hydration can migrate it again", async () => {
    activeRuntimeKey = "runtime-hydration-race"
    const raceTarget = createMessageQueueTarget("session-hydration-race", "/repo", activeRuntimeKey)!
    const raceKey = getMessageQueueKey(raceTarget)
    respond = (call) => call.method === "POST"
      ? json({ revision: 20, session: { ...session([serverItem("srv-race", "accepted")]), sessionId: raceTarget.sessionId } })
      : json({ revision: 20, sessions: [{ ...session([serverItem("srv-race", "accepted")]), sessionId: raceTarget.sessionId }] })

    await useMessageQueueStore.getState().addToQueue(raceTarget, {
      content: "accepted",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    await useMessageQueueStore.getState().hydrate()

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(useMessageQueueStore.getState().queuedMessages[raceKey]?.map((message) => message.id)).toEqual(["srv-race"])
  })

  test("keeps accepted context available when an explicit remove uses a projection without context", async () => {
    const context = [{ kind: "synthetic" as const, text: "conflict payload" }]
    respond = (call) => call.method === "POST"
      ? json({ revision: 6, session: session([serverItem("srv-context", "with context")]) })
      : json({ revision: 7, session: session([]) })

    await useMessageQueueStore.getState().addToQueue(target, {
      content: "with context",
      context,
      sendConfig: { providerID: "p", modelID: "m" },
    })
    expect(useMessageQueueStore.getState().queuedMessages[key]?.[0]?.context).toBe(undefined)

    const removed = useMessageQueueStore.getState().removeFromQueue(target, "srv-context")
    expect(removed?.context).toEqual(context)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("suppresses a stale POST response when removal wins before server acceptance", async () => {
    let resolvePost: ((response: Response) => void) | undefined
    respond = (call) => {
      if (call.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve
        })
      }
      return json({ revision: 12, session: session([serverItem("keep", "unrelated")]) })
    }

    const adding = useMessageQueueStore.getState().addToQueue(target, {
      content: "remove before acceptance",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    const [optimistic] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!optimistic) throw new Error("optimistic queue item was not created")

    const removed = useMessageQueueStore.getState().removeFromQueue(target, optimistic.id)
    expect(removed?.id).toBe(optimistic.id)
    expect(calls).toHaveLength(1)

    resolvePost?.(json({
      revision: 11,
      session: session([
        serverItem("accepted-after-remove", "remove before acceptance"),
        serverItem("keep", "unrelated"),
      ]),
    }))
    await adding

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/message-queue/sessions/session-1/items",
      "DELETE /api/message-queue/sessions/session-1/items/accepted-after-remove",
    ])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((message) => message.id)).toEqual(["keep"])
  })

  test("serializes accepted-item cleanup before a queued clear", async () => {
    activeRuntimeKey = "runtime-enqueue-clear-race"
    const clearTarget = createMessageQueueTarget("session-enqueue-clear-race", "/repo", activeRuntimeKey)!
    const clearKey = getMessageQueueKey(clearTarget)
    const post = deferredResponse()
    const accepted = serverItem("accepted-clear", "clear after acceptance")
    respond = (call) => {
      if (call.method === "POST") return post.promise
      if (call.path.endsWith(`/items/${accepted.id}`)) {
        return json({ revision: 2, session: { ...session([]), sessionId: clearTarget.sessionId, directory: clearTarget.directory } })
      }
      if (call.method === "DELETE") {
        return json({ revision: 3, session: { ...session([]), sessionId: clearTarget.sessionId, directory: clearTarget.directory } })
      }
      return json({ revision: 4, sessions: [] })
    }

    const adding = useMessageQueueStore.getState().addToQueue(clearTarget, {
      content: accepted.content,
      sendConfig: { providerID: "p", modelID: "m" },
    })
    await Promise.resolve()
    expect(calls.map((call) => call.method)).toEqual(["POST"])

    useMessageQueueStore.getState().clearQueue(clearTarget)
    post.resolve(json({
      revision: 1,
      itemId: accepted.id,
      session: { ...session([accepted]), sessionId: clearTarget.sessionId, directory: clearTarget.directory },
    }))

    await adding
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "DELETE"])
    expect(calls[1]?.path).toBe(`/api/message-queue/sessions/${clearTarget.sessionId}/items/${accepted.id}`)
    expect(calls[2]?.path).toBe(`/api/message-queue/sessions/${clearTarget.sessionId}`)
    expect(useMessageQueueStore.getState().queuedMessages[clearKey]).toBe(undefined)
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
  })

  test("retains an accepted removal marker when compensating cleanup fails", async () => {
    activeRuntimeKey = "runtime-enqueue-cleanup-retry"
    const retryTarget = createMessageQueueTarget("session-enqueue-cleanup-retry", "/repo", activeRuntimeKey)!
    const retryKey = getMessageQueueKey(retryTarget)
    const post = deferredResponse()
    const accepted = serverItem("accepted-retry", "retry cleanup")
    let cleanupAttempts = 0
    respond = (call) => {
      if (call.method === "POST") return post.promise
      if (call.path.endsWith(`/items/${accepted.id}`)) {
        cleanupAttempts += 1
        return cleanupAttempts === 1
          ? new Response("cleanup failed", { status: 503 })
          : json({ revision: 5, session: { ...session([]), sessionId: retryTarget.sessionId, directory: retryTarget.directory } })
      }
      if (call.method === "GET") {
        return json({
          revision: cleanupAttempts === 1 ? 3 : 4,
          sessions: [{ ...session([accepted]), sessionId: retryTarget.sessionId, directory: retryTarget.directory }],
        })
      }
      return json({ revision: 6, sessions: [] })
    }

    const adding = useMessageQueueStore.getState().addToQueue(retryTarget, {
      content: accepted.content,
      sendConfig: { providerID: "p", modelID: "m" },
    })
    await Promise.resolve()
    const [optimistic] = useMessageQueueStore.getState().getQueueForTarget(retryTarget)
    if (!optimistic) throw new Error("optimistic queue item was not created")
    expect(useMessageQueueStore.getState().removeFromQueue(retryTarget, optimistic.id)?.id).toBe(optimistic.id)

    post.resolve(json({
      revision: 1,
      itemId: accepted.id,
      session: { ...session([accepted]), sessionId: retryTarget.sessionId, directory: retryTarget.directory },
    }))
    await expect(adding).rejects.toThrow()

    expect(useMessageQueueStore.getState().queuedMessages[retryKey]?.map((message) => message.id)).toEqual([accepted.id])
    const pending = Object.values(useMessageQueueStore.getState().pendingServerEnqueues)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ acceptedItemId: accepted.id, removed: true })

    await useMessageQueueStore.getState().hydrate()
    expect(cleanupAttempts).toBe(2)
    expect(useMessageQueueStore.getState().pendingServerEnqueues).toEqual({})
    expect(useMessageQueueStore.getState().queuedMessages[retryKey]).toBe(undefined)
  })

  test("accepted queue history survives automatic delivery and manual take without recapture", async () => {
    const historyTarget = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'history-accepted' };
    const item = serverItem('history-item', 'original prompt');
    respond = () => json({ revision: 100, session: { ...session([item]), sessionId: historyTarget.sessionId } });
    const pending = useMessageQueueStore.getState().addToQueue(historyTarget, {
      content: item.content,
      attachments: [{ ...attachment, dataUrl: 'file:///repo/note.txt' }],
      sendConfig: { providerID: 'p', modelID: 'm' },
    });
    const entries = () => selectInputHistoryEntries({ ...useInputHistoryStore.getState(), scope: 'session' }, historyTarget);
    expect(entries()).toHaveLength(0);
    await pending;
    expect(entries().map((entry) => entry.text)).toEqual(['original prompt']);
    expect(entries()[0]?.restorableAttachments[0]?.reference).toBe('file:///repo/note.txt');
    // A server delivery broadcast removes the projection, never the history.
    applyMessageQueueUpdatedEvent(updated(101, { ...session([]), sessionId: historyTarget.sessionId }), historyTarget.runtimeKey);
    expect(entries()).toHaveLength(1);
    respond = () => json({ revision: 102, session: { ...session([]), sessionId: historyTarget.sessionId }, items: [item] });
    await useMessageQueueStore.getState().takeForSend(historyTarget);
    expect(entries()).toHaveLength(1);
  });

  test("queue acceptance records the captured owner after the active runtime changes", async () => {
    const historyTarget = { runtimeKey: 'runtime-a', directory: '/original', sessionId: 'history-runtime-switch' };
    respond = () => {
      activeRuntimeKey = 'runtime-b';
      return json({ revision: 110, session: { ...session([]), sessionId: historyTarget.sessionId, directory: historyTarget.directory } });
    };
    await useMessageQueueStore.getState().addToQueue(historyTarget, {
      content: 'for original runtime', sendConfig: { providerID: 'p', modelID: 'm' },
    });
    expect(selectInputHistoryEntries({ ...useInputHistoryStore.getState(), scope: 'session' }, historyTarget).map((entry) => entry.text)).toEqual(['for original runtime']);
    expect(selectInputHistoryEntries({ ...useInputHistoryStore.getState(), scope: 'session' }, { ...historyTarget, runtimeKey: activeRuntimeKey })).toEqual([]);
  });

  test("a rejected queue acceptance records no history", async () => {
    const historyTarget = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'history-rejected' };
    respond = () => new Response('rejected', { status: 500 });
    await expect(useMessageQueueStore.getState().addToQueue(historyTarget, {
      content: 'rejected prompt', sendConfig: { providerID: 'p', modelID: 'm' },
    })).rejects.toThrow();
    expect(selectInputHistoryEntries({ ...useInputHistoryStore.getState(), scope: 'session' }, historyTarget)).toEqual([]);
  });

  test("addToQueue hands the captured context to the server, and a take brings it back", async () => {
    const context = [
      { kind: "context" as const, text: "issue body", metadata: issueMetadata },
      { kind: "synthetic" as const, text: "conflict payload" },
    ]
    respond = () => json({ revision: 6, session: session([serverItem("srv-1", "with context")]) })
    await useMessageQueueStore.getState().addToQueue(target, {
      content: "with context",
      context,
      sendConfig: { providerID: "p", modelID: "m" },
    })
    expect(calls[0]?.body.item.context).toEqual(context)
    expect(calls[0]?.body.item.contextPreview).toBe("Bug")
    // The projection carries no context; the server strips payloads from snapshots.
    expect(useMessageQueueStore.getState().queuedMessages[key]?.[0]?.context).toBe(undefined)

    respond = () => json({ revision: 7, session: session([]), item: serverItem("srv-1", "with context", { context }) })
    const [taken] = await useMessageQueueStore.getState().takeForSend(target, "srv-1")
    expect(taken?.context).toEqual(context)
    expect(taken?.text).toBe("with context")
  })

  test("a server item with malformed context is rejected at the boundary", async () => {
    respond = () => new Response(JSON.stringify({
      revision: 8,
      session: session([]),
      item: { ...serverItem("srv-1", "x"), context: [{ kind: "context", text: "x", metadata: { openchamberContext: { kind: "nope" } } }] },
    }), { status: 200 })
    await expect(useMessageQueueStore.getState().takeForSend(target, "srv-1")).rejects.toThrow()
  })

  test("addToQueue keeps a retryable optimistic entry when the server refuses", async () => {
    respond = () => new Response("nope", { status: 500 })
    await expect(useMessageQueueStore.getState().addToQueue(target, {
      content: "x",
      sendConfig: { providerID: "p", modelID: "m" },
    })).rejects.toThrow()
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((message) => message.content)).toEqual(["x"])
    expect(Object.values(useMessageQueueStore.getState().pendingServerEnqueues)).toHaveLength(1)
  })

  test("addToQueue refuses a message with no captured model", async () => {
    await expect(useMessageQueueStore.getState().addToQueue(target, { content: "x" })).rejects.toThrow()
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    expect(calls).toHaveLength(0)
  })

  test("takeForSend brings the full message back, attachments included", async () => {
    respond = () => json({
      revision: 7,
      session: session([]),
      item: serverItem("q1", "with file", {
        attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: "data:text/plain;base64,aGk=" }],
      }),
    })
    const [taken] = await useMessageQueueStore.getState().takeForSend(target, "q1")

    expect(calls[0]?.path).toBe("/api/message-queue/sessions/session-1/items/q1/take")
    expect(calls[0]?.method).toBe("POST")
    expect(taken?.content).toBe("with file")
    expect(taken?.attachments?.[0]?.dataUrl).toBe("data:text/plain;base64,aGk=")
    expect(taken?.attachments?.[0]?.file.size).toBe(2)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("acknowledges a successful server take receipt", async () => {
    respond = (call) => call.path.includes("take-receipts")
      ? json({ acknowledged: true })
      : json({ revision: 7, session: session([]), item: serverItem("q1", "taken") })
    const [taken] = await useMessageQueueStore.getState().takeForSend(target, "q1")
    await useMessageQueueStore.getState().acknowledgeTakenServerBatch(target, taken ? [taken] : [])

    expect(calls.map((call) => call.path)).toEqual([
      "/api/message-queue/sessions/session-1/items/q1/take",
      "/api/message-queue/sessions/session-1/take-receipts/" + calls[0]?.body.operationId + "/ack",
    ])
  })

  test("keeps a failed take acknowledgement for hydration without repeating the take", async () => {
    const item = serverItem("ack-retry", "send once")
    let acknowledgementAttempts = 0
    respond = (call) => {
      if (call.method === "GET") return json({ revision: 8, sessions: [session([])] })
      if (call.path.includes("take-receipts")) {
        acknowledgementAttempts += 1
        return acknowledgementAttempts === 1 ? new Response("nope", { status: 503 }) : json({ acknowledged: true })
      }
      return json({ revision: 7, session: session([]), item })
    }

    const [taken] = await useMessageQueueStore.getState().takeForSend(target, item.id)
    await expect(useMessageQueueStore.getState().acknowledgeTakenServerBatch(target, taken ? [taken] : [])).rejects.toThrow()

    expect(useMessageQueueStore.getState().pendingServerTakes).toEqual({})
    expect(Object.values(useMessageQueueStore.getState().pendingServerTakeAcks)).toHaveLength(1)
    useMessageQueueStore.getState().clearQueue(target)
    expect(Object.values(useMessageQueueStore.getState().pendingServerTakeAcks)).toHaveLength(1)

    await useMessageQueueStore.getState().hydrate()

    expect(acknowledgementAttempts).toBe(2)
    expect(calls.filter((call) => call.path.endsWith(`/items/${item.id}/take`))).toHaveLength(1)
    expect(useMessageQueueStore.getState().pendingServerTakeAcks).toEqual({})
  })

  test("treats an empty takeAll as terminal while retaining only a failed acknowledgement", async () => {
    let acknowledgementAttempts = 0
    respond = (call) => {
      if (call.method === "GET") return json({ revision: 10, sessions: [session([])] })
      if (call.path.includes("take-receipts")) {
        acknowledgementAttempts += 1
        return acknowledgementAttempts === 1 ? new Response("nope", { status: 503 }) : json({ acknowledged: true })
      }
      return json({ revision: 9, session: session([]), items: [], generation: 1 })
    }

    expect(await useMessageQueueStore.getState().takeForSend(target)).toEqual([])

    expect(useMessageQueueStore.getState().pendingServerTakes).toEqual({})
    expect(Object.values(useMessageQueueStore.getState().pendingServerTakeAcks)).toHaveLength(1)

    await useMessageQueueStore.getState().hydrate()

    expect(acknowledgementAttempts).toBe(2)
    expect(calls.filter((call) => call.path === "/api/message-queue/sessions/session-1/take")).toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith("/restore"))).toBe(false)
    expect(useMessageQueueStore.getState().pendingServerTakeAcks).toEqual({})
  })

  test("takeForSend without an id takes everything the server is not already sending", async () => {
    respond = () => json({ revision: 8, session: session([serverItem("q1", "in flight")], "q1"), items: [serverItem("q2", "second")] })
    const taken = await useMessageQueueStore.getState().takeForSend(target)

    expect(calls[0]?.path).toBe("/api/message-queue/sessions/session-1/take")
    expect(calls[0]?.method).toBe("POST")
    expect(taken.map((m) => m.content)).toEqual(["second"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
  })

  test("a failed take re-reads the server so a stale projection is cleared", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "already delivered", text: "already delivered", createdAt: 1 }] } })
    respond = (call) => (call.path.endsWith("/take")
      ? new Response(JSON.stringify({ error: "queued message not found" }), { status: 404 })
      : json({ revision: 12, sessions: [] }))
    await expect(useMessageQueueStore.getState().takeForSend(target, "q1")).rejects.toThrow()

    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("broadcasts update the projection but never move it backwards", () => {
    applyMessageQueueUpdatedEvent(updated(4, session([serverItem("q1", "newer")])), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["newer"])

    applyMessageQueueUpdatedEvent(updated(2, session([serverItem("q0", "older")])), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["newer"])

    applyMessageQueueUpdatedEvent(updated(9, session([serverItem("q1", "newer")])), "runtime-b")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["newer"])
  })

  test("an empty session without a directory still clears the projection it was keyed under", () => {
    applyMessageQueueUpdatedEvent(updated(4, session([serverItem("q1", "queued")], "q1")), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1)
    expect(useMessageQueueStore.getState().sendingIds[key]).toEqual(["q1"])

    // A server that forgot the directory once the queue emptied.
    applyMessageQueueUpdatedEvent(updated(5, { sessionId: "session-1", directory: "", items: [], sendingId: null }), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    expect(useMessageQueueStore.getState().sendingIds[key]).toBe(undefined)

    // Still never backwards, and never another runtime's projection.
    applyMessageQueueUpdatedEvent(updated(6, session([serverItem("q2", "later")])), "runtime-a")
    applyMessageQueueUpdatedEvent(updated(3, { sessionId: "session-1", directory: "", items: [], sendingId: null }), "runtime-a")
    applyMessageQueueUpdatedEvent(updated(9, { sessionId: "session-1", directory: "", items: [], sendingId: null }), "runtime-b")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["later"])
  })

  test("moves projections off an old directory alias and rejects a stale delete incarnation", () => {
    const oldTarget = createMessageQueueTarget("session-move", "/old-repo", "runtime-a")!
    const newTarget = createMessageQueueTarget("session-move", "/new-repo", "runtime-a")!
    const oldItem = serverItem("old-item", "old directory")
    const newItem = serverItem("new-item", "new directory")

    applyMessageQueueUpdatedEvent(updated(20, { ...session([oldItem]), sessionId: oldTarget.sessionId, directory: oldTarget.directory, generation: 2 }), "runtime-a")
    applyMessageQueueUpdatedEvent(updated(21, { ...session([newItem]), sessionId: newTarget.sessionId, directory: newTarget.directory, generation: 2 }), "runtime-a")

    expect(useMessageQueueStore.getState().queuedMessages[getMessageQueueKey(oldTarget)]).toBe(undefined)
    expect(useMessageQueueStore.getState().queuedMessages[getMessageQueueKey(newTarget)]?.map((item) => item.id)).toEqual(["new-item"])

    applyMessageQueueUpdatedEvent(updated(22, {
      sessionId: newTarget.sessionId,
      directory: newTarget.directory,
      items: [],
      sendingId: null,
      generation: 3,
      deleted: true,
    }), "runtime-a")
    applyMessageQueueUpdatedEvent(updated(23, {
      ...session([serverItem("recreated", "new incarnation")]),
      sessionId: newTarget.sessionId,
      directory: newTarget.directory,
      generation: 4,
    }), "runtime-a")
    applyMessageQueueUpdatedEvent(updated(22, {
      ...session([serverItem("stale", "old incarnation")]),
      sessionId: newTarget.sessionId,
      directory: newTarget.directory,
      generation: 3,
    }), "runtime-a")

    expect(useMessageQueueStore.getState().queuedMessages[getMessageQueueKey(newTarget)]?.map((item) => item.id)).toEqual(["recreated"])
  })

  test("replays a persisted take receipt after reload and restores the full payload once", async () => {
    const recoveryTarget = createMessageQueueTarget("session-recovery", "/repo", "runtime-a")!
    const recoveryKey = getMessageQueueKey(recoveryTarget)
    const operationId = "take-after-crash"
    const context = [{ kind: "synthetic" as const, text: "captured context" }]
    const item = serverItem("recovery-item", "recover this", {
      attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: "data:text/plain;base64,aGk=" }],
      context,
    })
    useMessageQueueStore.setState({
      pendingServerTakes: {
        [recoveryKey]: {
          target: recoveryTarget,
          operationId,
          deletionGeneration: 0,
          takeGeneration: 1,
          messageId: item.id,
        },
      },
    })
    respond = (call) => {
      if (call.method === "GET") {
        return json({
          revision: 10,
          sessions: [{ ...session([]), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 1 }],
          sessionLifecycles: {
            [recoveryTarget.sessionId]: { directory: recoveryTarget.directory, generation: 1, restoreRequiresReceipt: true },
          },
        })
      }
      if (call.path.endsWith(`/items/${item.id}/take`)) {
        return json({
          revision: 11,
          session: { ...session([]), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 1 },
          generation: 1,
          item,
        })
      }
      return json({
        revision: 12,
        session: { ...session([item]), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 1 },
      })
    }

    await useMessageQueueStore.getState().hydrate()

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/message-queue",
      `POST /api/message-queue/sessions/${recoveryTarget.sessionId}/items/${item.id}/take`,
      `POST /api/message-queue/sessions/${recoveryTarget.sessionId}/restore`,
    ])
    expect(calls[1]?.body).toMatchObject({ operationId, generation: 1 })
    expect(calls[2]?.body).toMatchObject({ operationId, generation: 1, items: [{ id: item.id, context }] })
    const restored = useMessageQueueStore.getState().queuedMessages[recoveryKey]?.[0]
    expect(restored?.id).toBe(item.id)
    expect(restored?.context).toEqual(context)
    expect(restored?.attachments?.[0]?.dataUrl).toBe(item.attachments[0]?.dataUrl)
    expect(useMessageQueueStore.getState().pendingServerTakes).toEqual({})
  })

  test("does not redirect a persisted take to another runtime", async () => {
    const recoveryTarget = createMessageQueueTarget("session-switch", "/repo", "runtime-a")!
    const recoveryKey = getMessageQueueKey(recoveryTarget)
    useMessageQueueStore.setState({
      pendingServerTakes: {
        [recoveryKey]: {
          target: recoveryTarget,
          operationId: "take-runtime-bound",
          deletionGeneration: 0,
          takeGeneration: 1,
          messageId: "item-runtime-bound",
        },
      },
    })
    respond = (call) => call.method === "GET"
      ? json({ revision: 1, sessions: [] })
      : json({ revision: 1, session: { ...session([]), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 1 }, item: serverItem("item-runtime-bound", "wrong runtime") })

    activeRuntimeKey = "runtime-b"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-a")
    await useMessageQueueStore.getState().hydrate()

    expect(calls.map((call) => call.path)).toEqual(["/api/message-queue"])
    expect(useMessageQueueStore.getState().pendingServerTakes[recoveryKey]?.operationId).toBe("take-runtime-bound")
  })

  test("persists a stale-runtime restore until the original runtime returns", async () => {
    const recoveryTarget = createMessageQueueTarget("session-stale-restore", "/repo", "runtime-a")!
    const recoveryKey = getMessageQueueKey(recoveryTarget)
    const item = serverItem("stale-restore-item", "restore after a failed send", {
      context: [{ kind: "synthetic", text: "captured context" }],
    })
    let serverItems: ServerItem[] = [item]
    let restoreAttempts = 0
    let takeAttempts = 0
    let acknowledgementAttempts = 0
    let hydrationAttempts = 0

    respond = (call) => {
      if (call.method === "GET") {
        hydrationAttempts += 1
        return json({
          revision: hydrationAttempts,
          sessions: [{ ...session(serverItems), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 3 }],
          sessionLifecycles: {
            [recoveryTarget.sessionId]: { directory: recoveryTarget.directory, generation: 3, restoreRequiresReceipt: true },
          },
        })
      }
      if (call.path.endsWith(`/items/${item.id}/take`)) {
        takeAttempts += 1
        serverItems = []
        return json({
          revision: 10 + takeAttempts,
          session: { ...session([]), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 3 },
          generation: 3,
          item,
        })
      }
      if (call.path.endsWith("/restore")) {
        restoreAttempts += 1
        serverItems = [item]
        return json({
          revision: 20,
          session: { ...session(serverItems), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 3 },
        })
      }
      if (call.path.includes("take-receipts")) {
        acknowledgementAttempts += 1
        return json({ acknowledged: true })
      }
      return json({ revision: 30, session: { ...session(serverItems), sessionId: recoveryTarget.sessionId, directory: recoveryTarget.directory, generation: 3 } })
    }

    await useMessageQueueStore.getState().hydrate()
    const guard = useMessageQueueStore.getState().getQueueRestorationGuard(recoveryTarget)
    const [taken] = await useMessageQueueStore.getState().takeForSend(recoveryTarget, item.id)
    if (!taken) throw new Error("server take did not return the item")

    // The composer send fails after taking the item, while the user switches
    // away from the runtime that owns the queue.
    activeRuntimeKey = "runtime-b"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-a")
    expect(await useMessageQueueStore.getState().restoreQueue(recoveryTarget, [taken], guard)).toBe(false)

    const pending = useMessageQueueStore.getState().pendingServerRestores[recoveryKey]
    expect(pending).toMatchObject({
      target: recoveryTarget,
      operationId: useMessageQueueStore.getState().pendingServerTakes[recoveryKey]?.operationId,
      mutationGeneration: 3,
    })
    expect(pending?.messages).toEqual([taken])
    expect(restoreAttempts).toBe(0)
    expect(acknowledgementAttempts).toBe(0)

    const persisted = useMessageQueueStore.getState().pendingServerRestores
    const migrated = migrateMessageQueueState({ pendingServerRestores: persisted }, 6)
    expect(migrated.pendingServerRestores?.[recoveryKey]).toMatchObject({
      target: recoveryTarget,
      operationId: pending?.operationId,
      mutationGeneration: 3,
      messages: [taken],
    })

    activeRuntimeKey = "runtime-a"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-b")
    await useMessageQueueStore.getState().hydrate()

    expect(restoreAttempts).toBe(1)
    expect(takeAttempts).toBe(1)
    expect(acknowledgementAttempts).toBe(0)
    expect(useMessageQueueStore.getState().pendingServerRestores[recoveryKey]).toBe(undefined)
    expect(useMessageQueueStore.getState().queuedMessages[recoveryKey]?.map((message) => message.id)).toEqual([item.id])

    // Re-hydration sees the restored item and must not replay the restore.
    await useMessageQueueStore.getState().hydrate()
    expect(restoreAttempts).toBe(1)

    const [retried] = await useMessageQueueStore.getState().takeForSend(recoveryTarget, item.id)
    if (!retried) throw new Error("restored item could not be taken again")
    await useMessageQueueStore.getState().acknowledgeTakenServerBatch(recoveryTarget, [retried])

    expect(takeAttempts).toBe(2)
    expect(restoreAttempts).toBe(1)
    expect(acknowledgementAttempts).toBe(1)
  })

  test("keeps a restore pending across a directory move and retries only against the new owner", async () => {
    const oldTarget = createMessageQueueTarget("session-directory-restore", "/old-repo", "runtime-a")!
    const newTarget = createMessageQueueTarget("session-directory-restore", "/new-repo", "runtime-a")!
    const oldKey = getMessageQueueKey(oldTarget)
    const newKey = getMessageQueueKey(newTarget)
    const item = serverItem("directory-restore-item", "restore after move", { context: [{ kind: "synthetic", text: "captured" }] })
    let serverItems: ServerItem[] = [item]
    let restoreAttempts = 0
    let hydrationAttempts = 0

    respond = (call) => {
      if (call.method === "GET") {
        hydrationAttempts += 1
        return json({
          revision: hydrationAttempts,
          sessions: [{ ...session(serverItems), sessionId: newTarget.sessionId, directory: hydrationAttempts === 1 ? oldTarget.directory : newTarget.directory, generation: 3 }],
          sessionLifecycles: {
            [newTarget.sessionId]: { directory: hydrationAttempts === 1 ? oldTarget.directory : newTarget.directory, generation: 3, restoreRequiresReceipt: true },
          },
        })
      }
      if (call.path.endsWith(`/items/${item.id}/take`)) {
        serverItems = []
        return json({ revision: 10, session: { ...session([]), sessionId: oldTarget.sessionId, directory: oldTarget.directory, generation: 3 }, generation: 3, item })
      }
      if (call.path.endsWith("/restore")) {
        restoreAttempts += 1
        expect(call.body.directory).toBe(newTarget.directory)
        serverItems = [item]
        return json({ revision: 20, session: { ...session(serverItems), sessionId: newTarget.sessionId, directory: newTarget.directory, generation: 3 } })
      }
      return json({ acknowledged: true })
    }

    await useMessageQueueStore.getState().hydrate()
    const guard = useMessageQueueStore.getState().getQueueRestorationGuard(oldTarget)
    const [taken] = await useMessageQueueStore.getState().takeForSend(oldTarget, item.id)
    if (!taken) throw new Error("server take did not return the item")

    applyMessageQueueUpdatedEvent(updated(12, {
      ...session([]),
      sessionId: oldTarget.sessionId,
      directory: newTarget.directory,
      generation: 3,
    }), oldTarget.runtimeKey)
    expect(await useMessageQueueStore.getState().restoreQueue(oldTarget, [taken], guard)).toBe(false)
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]?.messages).toEqual([taken])
    expect(restoreAttempts).toBe(0)

    await useMessageQueueStore.getState().hydrate()

    expect(restoreAttempts).toBe(1)
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]).toBe(undefined)
    expect(useMessageQueueStore.getState().queuedMessages[newKey]?.map((message) => message.id)).toEqual([item.id])
  })

  test("retains the complete payload when a recoverable identity update invalidates the restore guard", async () => {
    const oldTarget = createMessageQueueTarget("session-identity-restore", "/repo", "runtime-a")!
    const newTarget = createMessageQueueTarget("session-identity-restore", "/repo-new", "runtime-a")!
    const oldKey = getMessageQueueKey(oldTarget)
    const item = serverItem("identity-restore-item", "restore after identity update", {
      attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: "data:text/plain;base64,aGk=" }],
      context: [{ kind: "synthetic", text: "captured context" }],
    })
    let restoreAttempts = 0
    applyMessageQueueUpdatedEvent(updated(1, {
      ...session([item]),
      sessionId: oldTarget.sessionId,
      directory: oldTarget.directory,
      generation: 3,
    }), oldTarget.runtimeKey)
    respond = (call) => {
      if (call.path.endsWith(`/items/${item.id}/take`)) {
        return json({ revision: 2, session: { ...session([]), sessionId: oldTarget.sessionId, directory: oldTarget.directory, generation: 3 }, generation: 3, item })
      }
       restoreAttempts += 1
       return json({ revision: 3, session: { ...session([item]), sessionId: newTarget.sessionId, directory: newTarget.directory, generation: 3 } })
    }

    const guard = useMessageQueueStore.getState().getQueueRestorationGuard(oldTarget)
    const [taken] = await useMessageQueueStore.getState().takeForSend(oldTarget, item.id)
    if (!taken) throw new Error("server take did not return the item")

    useMessageQueueStore.getState().applyServerSession({
      ...session([]),
      sessionId: newTarget.sessionId,
      directory: newTarget.directory,
      generation: 3,
    }, 4, oldTarget.runtimeKey)
    expect(await useMessageQueueStore.getState().restoreQueue(oldTarget, [taken], guard)).toBe(false)

    expect(restoreAttempts).toBe(0)
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]).toMatchObject({
      operationId: useMessageQueueStore.getState().pendingServerTakes[oldKey]?.operationId,
      mutationGeneration: 3,
      messages: [taken],
    })
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]?.messages[0]?.attachments?.[0]?.dataUrl).toBe(item.attachments[0]?.dataUrl)
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]?.messages[0]?.context).toEqual(item.context)

    useMessageQueueStore.getState().clearQueue(newTarget)
    expect(useMessageQueueStore.getState().pendingServerRestores[oldKey]?.blocked).toBe(true)
  })

  test("invalidates a pending restore on clear and session deletion", async () => {
    const invalidationTarget = createMessageQueueTarget("session-restore-invalidation", "/repo", "runtime-a")!
    const invalidationKey = getMessageQueueKey(invalidationTarget)
    const item = { id: "restore-invalidation-item", content: "do not restore", text: "do not restore", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }
    useMessageQueueStore.setState({
      pendingServerRestores: {
        [invalidationKey]: {
          target: invalidationTarget,
          messages: [item],
          deletionGeneration: 0,
          operationId: "restore-invalidation",
          mutationGeneration: 1,
        },
      },
    })
    respond = (call) => call.method === "GET"
      ? json({ revision: 3, sessions: [] })
      : json({ revision: 2, session: { ...session([]), sessionId: invalidationTarget.sessionId, directory: invalidationTarget.directory, generation: 1 } })

    useMessageQueueStore.getState().clearQueue(invalidationTarget)
    expect(useMessageQueueStore.getState().pendingServerRestores[invalidationKey]?.blocked).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await useMessageQueueStore.getState().hydrate()

    expect(calls.some((call) => call.path.endsWith("/restore"))).toBe(false)

    useMessageQueueStore.setState({
      pendingServerRestores: {
        [invalidationKey]: {
          target: invalidationTarget,
          messages: [item],
          deletionGeneration: 1,
          operationId: "restore-deletion",
          mutationGeneration: 1,
        },
      },
    })
    useMessageQueueStore.getState().clearQueueForSessionDeletion(invalidationTarget)
    expect(useMessageQueueStore.getState().pendingServerRestores[invalidationKey]).toBe(undefined)
  })

  test("acknowledges an in-flight take invalidated by clear without sending its payload", async () => {
    const takeTarget = createMessageQueueTarget("session-clear-take", "/repo", "runtime-a")!
    const takeKey = getMessageQueueKey(takeTarget)
    const item = serverItem("clear-item", "must not send")
    applyMessageQueueUpdatedEvent(updated(30, { ...session([item]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 }), "runtime-a")
    let resolveTake: ((response: Response) => void) | undefined
    respond = (call) => {
      if (call.path.endsWith(`/items/${item.id}/take`)) {
        return new Promise<Response>((resolve) => {
          resolveTake = resolve
        })
      }
      if (call.path.endsWith(`/take-receipts/` + calls[0]?.body.operationId + "/ack")) return json({ acknowledged: true })
      return json({ revision: 32, session: { ...session([]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 } })
    }

    const taking = useMessageQueueStore.getState().takeForSend(takeTarget, item.id)
    await Promise.resolve()
    useMessageQueueStore.getState().clearQueue(takeTarget)
    resolveTake?.(json({
      revision: 31,
      session: { ...session([]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 },
      generation: 1,
      item,
    }))

    expect(await taking).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((call) => call.path.includes("take-receipts") && call.path.endsWith("/ack"))).toBe(true)
    expect(useMessageQueueStore.getState().pendingServerTakes[takeKey]).toBe(undefined)
  })

  test("drops an in-flight take after session deletion without restoring it", async () => {
    const takeTarget = createMessageQueueTarget("session-delete-take", "/repo", "runtime-a")!
    const item = serverItem("delete-item", "deleted")
    applyMessageQueueUpdatedEvent(updated(40, { ...session([item]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 }), "runtime-a")
    let resolveTake: ((response: Response) => void) | undefined
    respond = (call) => call.path.endsWith(`/items/${item.id}/take`)
      ? new Promise<Response>((resolve) => {
        resolveTake = resolve
      })
      : json({ revision: 41, session: { ...session([]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 } })

    const taking = useMessageQueueStore.getState().takeForSend(takeTarget, item.id)
    await Promise.resolve()
    useMessageQueueStore.getState().clearQueueForSessionDeletion(takeTarget)
    resolveTake?.(json({
      revision: 42,
      session: { ...session([]), sessionId: takeTarget.sessionId, directory: takeTarget.directory, generation: 1 },
      generation: 1,
      item,
    }))

    expect(await taking).toEqual([])
    expect(useMessageQueueStore.getState().getQueueForTarget(takeTarget)).toEqual([])
  })

  test("removeFromQueue and clearQueue update locally and tell the server", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "a", text: "a", createdAt: 1 }, { id: "q2", content: "b", text: "b", createdAt: 2 }] } })
    respond = () => json({ revision: 10, session: session([serverItem("q2", "b")]) })
    useMessageQueueStore.getState().removeFromQueue(target, "q1")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q2"])
    await Promise.resolve()
    await Promise.resolve()
    expect(calls[0]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1/items/q1", body: { directory: "/repo" } })

    respond = () => json({ revision: 11, session: session([]) })
    useMessageQueueStore.getState().clearQueue(target)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[1]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1", body: { directory: "/repo" } })
  })

  test("reorderQueue sends the complete new order", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "a", text: "a", createdAt: 1 }, { id: "q2", content: "b", text: "b", createdAt: 2 }] } })
    respond = () => json({ revision: 12, session: session([serverItem("q2", "b"), serverItem("q1", "a")]) })
    useMessageQueueStore.getState().reorderQueue(target, "q2", "q1")
    await Promise.resolve()
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/message-queue/sessions/session-1/order", body: { itemIds: ["q2", "q1"], directory: "/repo" } })
  })

  test("hold mutations carry the session generation and monotonic sequence", async () => {
    respond = () => json({ held: true, expiresAt: 100, sequence: 1 })
    const holdTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)

    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/message-queue/sessions/session-1/hold",
      body: { directory: "/repo", held: true, generation: 0, sequence: 1 },
    })
    expect(calls[0]?.body.clientToken).toBeTruthy()
  })

  test("stale hold assertions remain rejected after a directory move", async () => {
    applyMessageQueueUpdatedEvent(updated(1, { ...session([]), generation: 1 }), "runtime-a")
    const oldTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    applyMessageQueueUpdatedEvent(updated(2, { ...session([]), directory: "/repo-new", generation: 1 }), "runtime-a")

    await expect(useMessageQueueStore.getState().setServerHold(oldTarget, true)).rejects.toThrow("obsolete session incarnation")
    expect(calls).toHaveLength(0)
  })

  test("runtime switches serialize old hold cleanup, retry failure, and preserve the new runtime hold", async () => {
    let resolveAssertion: ((response: Response) => void) | undefined
    let releaseAttempts = 0
    respond = (call) => {
      if (!call.path.endsWith("/hold")) return json({ revision: 1, session: session([]) })
      const held = call.body.held === true
      const baseUrl = call.runtimeTarget?.apiBaseUrl ?? activeRuntimeBaseUrl
      if (baseUrl === "http://runtime-a.test" && held) {
        return new Promise<Response>((resolve) => {
          resolveAssertion = resolve
        })
      }
      if (baseUrl === "http://runtime-a.test" && !held) {
        releaseAttempts += 1
        return releaseAttempts === 1
          ? json({}, 500)
          : json({ held: false, expiresAt: null, sequence: call.body.sequence })
      }
      return json({ held, expiresAt: held ? 100 : null, sequence: call.body.sequence })
    }

    const oldTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    const assertion = useMessageQueueStore.getState().setServerHold(oldTarget, true)
    await Promise.resolve()
    expect(calls).toHaveLength(1)

    activeRuntimeKey = "runtime-b"
    activeRuntimeBaseUrl = "http://runtime-b.test"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-a")
    const newTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    const newHold = useMessageQueueStore.getState().setServerHold(newTarget, true)
    await newHold
    expect(calls[1]?.body).toMatchObject({ held: true, sequence: 1 })

    const release = useMessageQueueStore.getState().setServerHold(oldTarget, false, { releaseForRuntimeSwitch: true })
    // The cleanup lane is independent from the unresolved assertion lane: it
    // must reach the old runtime before that request reaches its timeout.
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({
      method: "PUT",
      path: `/api/message-queue/sessions/${oldTarget.sessionId}/hold`,
      runtimeTarget: { apiBaseUrl: "http://runtime-a.test" },
      body: { directory: "/repo", held: false, sequence: 2, generation: oldTarget.generation, clientToken: oldTarget.clientToken },
    })
    expect(resolveAssertion).toBeDefined()
    resolveAssertion?.(json({ held: true, expiresAt: 100, sequence: 1 }))
    await assertion
    await expect(release).rejects.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(releaseAttempts).toBe(2)
    const oldRuntimeReleases = calls.filter((call) => call.runtimeTarget?.apiBaseUrl === "http://runtime-a.test")
    expect(oldRuntimeReleases).toHaveLength(2)
    expect(oldRuntimeReleases.every((call) => call.body.held === false)).toBe(true)
    expect(oldRuntimeReleases.every((call) => call.body.generation === oldTarget.generation)).toBe(true)
    expect(oldRuntimeReleases.every((call) => call.body.clientToken === oldTarget.clientToken)).toBe(true)
    expect(oldRuntimeReleases.every((call) => call.body.sequence === 2)).toBe(true)
    expect(calls[1]?.body.held).toBe(true)
  })

  test("a reload keeps the persisted hold owner and continues its sequence", async () => {
    // Emulate the strict server owner rule: a foreign token cannot mutate an
    // active hold, and a stale same-token sequence is refused with an echo.
    let ownerToken: string | null = null
    let ownerSequence = 0
    respond = (call) => {
      if (!call.path.endsWith("/hold")) return json({ revision: 1, session: session([]) })
      const held = call.body.held === true
      const sequence = call.body.sequence
      const clientToken = call.body.clientToken
      if (ownerToken !== null && ownerToken !== clientToken) {
        return json({ held: true, expiresAt: 100, sequence: ownerSequence })
      }
      if (sequence < ownerSequence) {
        return json({ held: ownerToken !== null, expiresAt: ownerToken !== null ? 100 : null, sequence: ownerSequence })
      }
      ownerToken = held ? clientToken : null
      ownerSequence = sequence
      return json({ held, expiresAt: held ? 100 : null, sequence })
    }

    const firstTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(firstTarget, true)
    expect(calls[0]?.body).toMatchObject({ held: true, sequence: 1, clientToken: firstTarget.clientToken })
    expect(ownerToken).toBe(firstTarget.clientToken)

    // Simulate a page reload: fresh module state, same browser storage.
    const reloaded = await importFreshMessageQueueStore()
    const reloadedTarget = reloaded.useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    expect(reloadedTarget.clientToken).toBe(firstTarget.clientToken)

    // The previous incarnation's hold is re-asserted as its owner, not refused
    // as a foreign token, and the sequence continues past the server's echo.
    await reloaded.useMessageQueueStore.getState().setServerHold(reloadedTarget, true)
    expect(calls[1]?.body).toMatchObject({ held: true, sequence: 2, clientToken: firstTarget.clientToken })
    expect(ownerToken).toBe(firstTarget.clientToken)

    await reloaded.useMessageQueueStore.getState().setServerHold(reloadedTarget, false)
    expect(calls[2]?.body).toMatchObject({ held: false, sequence: 3, clientToken: firstTarget.clientToken })
    expect(ownerToken).toBeNull()
  })

  test("switching away and back keeps the runtime's persisted hold owner", () => {
    const firstTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    activeRuntimeKey = "runtime-b"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-a")
    const otherTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    activeRuntimeKey = "runtime-a"
    useMessageQueueStore.getState().resetForRuntimeSwitch("runtime-b")
    const backTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)

    expect(backTarget.clientToken).toBe(firstTarget.clientToken)
    expect(otherTarget.clientToken).not.toBe(firstTarget.clientToken)
  })

  test("a release refused with a newer echoed sequence retries and clears the hold", async () => {
    let serverHeld = false
    let serverSequence = 0
    respond = (call) => {
      if (!call.path.endsWith("/hold")) return json({ revision: 1, session: session([]) })
      const held = call.body.held === true
      const sequence = call.body.sequence
      if (serverSequence > sequence) {
        return json({ held: serverHeld, expiresAt: serverHeld ? 100 : null, sequence: serverSequence })
      }
      serverHeld = held
      serverSequence = sequence
      return json({ held, expiresAt: held ? 100 : null, sequence })
    }

    const holdTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)
    // The server's owner sequence is ahead of the client's counter; the first
    // release is refused with that echo and must retry above it.
    serverSequence = 40
    await useMessageQueueStore.getState().setServerHold(holdTarget, false)

    expect(serverHeld).toBe(false)
    const releaseCalls = calls.filter((call) => call.body.held === false)
    expect(releaseCalls.map((call) => call.body.sequence)).toEqual([2, 41])
  })

  test("a stale hold assertion follows the server's echoed sequence", async () => {
    let serverHeld = false
    let serverSequence = 0
    respond = (call) => {
      if (!call.path.endsWith("/hold")) return json({ revision: 1, session: session([]) })
      const held = call.body.held === true
      const sequence = call.body.sequence
      if (sequence < serverSequence) {
        return json({ held: serverHeld, expiresAt: serverHeld ? 100 : null, sequence: serverSequence })
      }
      serverHeld = held
      serverSequence = sequence
      return json({ held, expiresAt: held ? 100 : null, sequence })
    }

    const holdTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)
    // A concurrent owner advanced the sequence; the stale assert must retry
    // above the echo instead of leaving the old hold unextended.
    serverSequence = 10
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)

    expect(calls.map((call) => call.body)).toMatchObject([
      { held: true, sequence: 1 },
      { held: true, sequence: 2 },
      { held: true, sequence: 11 },
    ])
    expect(serverHeld).toBe(true)
    expect(serverSequence).toBe(11)
  })

  test("corrupt hold identity storage falls back to a working in-memory identity", async () => {
    holdIdentityStorage.setItem(HOLD_IDENTITY_STORAGE_KEY, "{not json")
    respond = (call) => call.path.endsWith("/hold")
      ? json({ held: call.body.held === true, expiresAt: call.body.held === true ? 100 : null, sequence: call.body.sequence })
      : json({ revision: 1, session: session([]) })

    const holdTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)
    await useMessageQueueStore.getState().setServerHold(holdTarget, false)

    expect(calls.map((call) => call.body)).toMatchObject([
      { held: true, sequence: 1 },
      { held: false, sequence: 2 },
    ])
    expect(calls[0]?.body.clientToken).toBeTruthy()
  })

  test("blocked hold identity storage keeps a stable in-memory identity", async () => {
    const blockedStorage: Storage = {
      getItem: () => { throw new Error("storage blocked") },
      setItem: () => { throw new Error("storage blocked") },
      removeItem: () => { throw new Error("storage blocked") },
      clear: () => { throw new Error("storage blocked") },
      key: () => { throw new Error("storage blocked") },
      get length(): number { throw new Error("storage blocked") },
    }
    holdIdentityStorage = blockedStorage
    respond = (call) => call.path.endsWith("/hold")
      ? json({ held: call.body.held === true, expiresAt: call.body.held === true ? 100 : null, sequence: call.body.sequence })
      : json({ revision: 1, session: session([]) })

    const holdTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId, target.directory)
    await useMessageQueueStore.getState().setServerHold(holdTarget, true)
    await useMessageQueueStore.getState().setServerHold(holdTarget, false)

    expect(calls.map((call) => call.body)).toMatchObject([
      { held: true, sequence: 1 },
      { held: false, sequence: 2 },
    ])
    expect(calls[1]?.body.clientToken).toBe(calls[0]?.body.clientToken)
  })
})
