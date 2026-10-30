import { beforeEach, describe, expect, mock, test } from "bun:test"
import { selectInputHistoryEntries, useInputHistoryStore } from "./useInputHistoryStore"
import type { AttachedFile } from "./types/sessionTypes"
import type { MessageQueueUpdatedEvent } from "./messageQueueStore"

type FetchCall = { path: string; method: string; body: ReturnType<typeof JSON.parse>; directory?: string }
let calls: FetchCall[] = []
let activeRuntimeKey = "runtime-a"
let respond: (call: FetchCall) => Response | Promise<Response> = () => new Response("{}", { status: 200 })

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (path: string, init?: RequestInit & { directory?: string | null }) => {
    const call: FetchCall = {
      path,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    // The directory that picks the server: a space's own for a directory of that space.
    if (init?.directory) call.directory = init.directory
    calls.push(call)
    return respond(call)
  },
}))
const desktop = await import("@/lib/desktop")
mock.module("@/lib/desktop", () => ({ ...desktop, isVSCodeRuntime: () => false }))
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => activeRuntimeKey }))
mock.module("@/lib/persistence", () => ({ updateDesktopSettings: async () => undefined }))

const {
  applyMessageQueueUpdatedEvent,
  createMessageQueueTarget,
  getMessageQueueKey,
  useMessageQueueStore,
} = await import("./messageQueueStore")

type ServerItem = MessageQueueUpdatedEvent["properties"]["session"]["items"][number]
type ServerSession = MessageQueueUpdatedEvent["properties"]["session"]

type ServerReply = {
  revision: number
  session?: ServerSession
  sessions?: ServerSession[]
  item?: ServerItem
  items?: ServerItem[]
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

type OrdinaryServerItem = Extract<ServerItem, { sendConfig: { providerID: string; modelID: string } }>;
const serverItem = (id: string, content: string, extra: Partial<OrdinaryServerItem> = {}): OrdinaryServerItem => ({
  id,
  createdAt: 1,
  content,
  text: content,
  attachments: [],
  sendConfig: { providerID: "p", modelID: "m" },
  ...extra,
})

const issueMetadata = { openchamberContext: { kind: "repository-issue" as const, number: 3, title: "Bug", url: "https://x/issues/3" } }

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
  useMessageQueueStore.getState().resetForRuntimeSwitch(activeRuntimeKey)
  activeRuntimeKey = "runtime-a"
  useInputHistoryStore.setState({ globalBuckets: {}, sessionBuckets: {} })
  calls = []
  respond = () => json({ revision: 1, session: session([]) })
  // Forgetting also drops the revision guard, so each test starts unordered.
  useMessageQueueStore.getState().forgetQueue(target)
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("server-owned message queue", () => {
  // First: the one-time upload of a legacy local queue happens before this
  // runtime is known to be server-owned, which the later hydrations establish.
  test("hydrate uploads messages queued by an older build before reading the server", async () => {
    useMessageQueueStore.setState({
      queuedMessages: {
        [key]: [{ id: "local-1", content: "from before", text: "from before", createdAt: 1, sendConfig: { providerID: "p", modelID: "m" } }],
      },
    })
    respond = (call) => (call.method === "POST"
      ? json({ revision: 2, session: session([serverItem("q1", "from before")]) })
      : json({ revision: 2, sessions: [session([serverItem("q1", "from before")])] }))
    await useMessageQueueStore.getState().hydrate()

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/message-queue/sessions/session-1/items",
      directory: "/repo",
      body: { directory: "/repo", item: { content: "from before", text: "from before", attachments: [], context: [], sendConfig: { providerID: "p", modelID: "m" } } },
    })
    expect(calls[1]?.path).toBe("/api/message-queue")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
  })

  test("hydrate replaces the runtime's projection with the server queue", async () => {
    respond = () => json({ revision: 3, sessions: [session([serverItem("q1", "hello")], "q1")] })
    await useMessageQueueStore.getState().hydrate()

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/message-queue"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.content)).toEqual(["hello"])
    expect(useMessageQueueStore.getState().sendingIds[key]).toEqual(["q1"])
  })

  test("hydrate keeps inherited scheduled items beside ordinary items", async () => {
    const scheduledTask = { projectId: "project-1", taskId: "task-1" }
    respond = () => json({ revision: 3, sessions: [session([
      { id: "scheduled-1", createdAt: 1, content: "Continue", text: "Continue", attachments: [], sendConfig: {}, scheduledTask },
      serverItem("ordinary-1", "Hello"),
    ])] })
    await useMessageQueueStore.getState().hydrate()
    const messages = useMessageQueueStore.getState().queuedMessages[key]
    expect(messages?.[0]?.scheduledTask).toEqual(scheduledTask)
    expect(messages?.[0]?.sendConfig).toBeUndefined()
    expect(messages?.[1]?.sendConfig).toEqual({ providerID: "p", modelID: "m" })
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
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("addToQueue shows the message at once and settles on the server's copy", async () => {
    respond = () => json({ revision: 5, session: session([serverItem("srv-1", "hi @reviewer", { agentMention: "reviewer" })]) })
    const pending = useMessageQueueStore.getState().addToQueue(target, {
      content: "hi @reviewer",
      text: "hi",
      agentMention: "reviewer",
      attachments: [{ ...attachment, agentPath: '/Users/me/Documents/note.txt' }],
      sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    })
    expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1)
    await pending

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/message-queue/sessions/session-1/items",
      directory: "/repo",
      body: {
        directory: "/repo",
        item: {
          content: "hi @reviewer",
          text: "hi",
          agentMention: "reviewer",
          attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: attachment.dataUrl, agentPath: '/Users/me/Documents/note.txt' }],
          context: [],
          sendConfig: { providerID: "p", modelID: "m", agent: "build" },
        },
      },
    })
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["srv-1"])
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

  test("a message queued as a goal keeps its goal on the server, in the projection, and on take", async () => {
    const goal = { objective: "the whole plan", tokenBudget: 5000 }
    respond = () => json({ revision: 9, session: session([serverItem("srv-1", "Implement this plan", { goal })]) })
    await useMessageQueueStore.getState().addToQueue(target, {
      content: "Implement this plan",
      sendConfig: { providerID: "p", modelID: "m" },
      goal,
    })
    expect(calls[0]?.body.item.goal).toEqual(goal)
    expect(useMessageQueueStore.getState().queuedMessages[key]?.[0]?.goal).toEqual(goal)

    respond = () => json({ revision: 10, session: session([]), item: serverItem("srv-1", "Implement this plan", { goal }) })
    const [taken] = await useMessageQueueStore.getState().takeForSend(target, "srv-1")
    expect(taken?.goal).toEqual(goal)
  })

  test("a server item with malformed context is rejected at the boundary", async () => {
    respond = () => new Response(JSON.stringify({
      revision: 8,
      session: session([]),
      item: { ...serverItem("srv-1", "x"), context: [{ kind: "context", text: "x", metadata: { openchamberContext: { kind: "nope" } } }] },
    }), { status: 200 })
    await expect(useMessageQueueStore.getState().takeForSend(target, "srv-1")).rejects.toThrow()
  })

  test("addToQueue rolls the optimistic entry back when the server refuses", async () => {
    respond = () => new Response("nope", { status: 500 })
    await expect(useMessageQueueStore.getState().addToQueue(target, {
      content: "x",
      sendConfig: { providerID: "p", modelID: "m" },
    })).rejects.toThrow()
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
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
        attachments: [{ id: "att-1", filename: "note.txt", mimeType: "text/plain", size: 2, source: "local", dataUrl: "data:text/plain;base64,aGk=", agentPath: '/Users/me/Documents/note.txt' }],
      }),
    })
    const [taken] = await useMessageQueueStore.getState().takeForSend(target, "q1")

    expect(calls[0]?.path).toBe("/api/message-queue/sessions/session-1/items/q1/take")
    expect(calls[0]?.method).toBe("POST")
    expect(taken?.content).toBe("with file")
    expect(taken?.attachments?.[0]?.dataUrl).toBe("data:text/plain;base64,aGk=")
    expect(taken?.attachments?.[0]?.agentPath).toBe('/Users/me/Documents/note.txt')
    expect(taken?.attachments?.[0]?.file.size).toBe(2)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
  })

  test("takeForSend without an id takes everything the server is not already sending", async () => {
    respond = () => json({ revision: 8, session: session([serverItem("q1", "in flight")], "q1"), items: [serverItem("q2", "second")] })
    const taken = await useMessageQueueStore.getState().takeForSend(target)

    expect(calls[0]?.path).toBe("/api/message-queue/sessions/session-1/take")
    expect(calls[0]?.method).toBe("POST")
    expect(taken.map((m) => m.content)).toEqual(["second"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
  })

  test("bulk take leaves scheduled items in the projection", async () => {
    const scheduled: ServerItem = {
      id: "scheduled-1", createdAt: 1, content: "Continue", text: "Continue", attachments: [], sendConfig: {},
      scheduledTask: { projectId: "project-1", taskId: "task-1" },
    }
    respond = () => json({ revision: 8, session: session([scheduled]), items: [serverItem("ordinary-1", "Hello")] })
    const taken = await useMessageQueueStore.getState().takeForSend(target)
    expect(taken.map((message) => message.id)).toEqual(["ordinary-1"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.[0]?.scheduledTask).toEqual(scheduled.scheduledTask)
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

  test("removeFromQueue and clearQueue update locally and tell the server", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "a", text: "a", createdAt: 1 }, { id: "q2", content: "b", text: "b", createdAt: 2 }] } })
    respond = () => json({ revision: 10, session: session([serverItem("q2", "b")]) })
    useMessageQueueStore.getState().removeFromQueue(target, "q1")
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q2"])
    await Promise.resolve()
    await Promise.resolve()
    expect(calls[0]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1/items/q1", body: undefined, directory: "/repo" })

    respond = () => json({ revision: 11, session: session([]) })
    useMessageQueueStore.getState().clearQueue(target)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    await Promise.resolve()
    expect(calls[1]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1", body: undefined, directory: "/repo" })
  })

  test("reorderQueue sends the complete new order", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "a", text: "a", createdAt: 1 }, { id: "q2", content: "b", text: "b", createdAt: 2 }] } })
    respond = () => json({ revision: 12, session: session([serverItem("q2", "b"), serverItem("q1", "a")]) })
    useMessageQueueStore.getState().reorderQueue(target, "q2", "q1")
    await Promise.resolve()
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/message-queue/sessions/session-1/order", body: { itemIds: ["q2", "q1"] }, directory: "/repo" })
  })
})

// A space's queue lives in that space's own server, which numbers its own revisions: the UI sends
// a space session's queue requests there, reads that space's queue from it, and never lets one
// owner's snapshot or revision speak for the other's sessions.
describe("a session in an isolated space", () => {
  const SPACE = "a1b2c3d4e5f6"
  const spaceDirectory = `/spaces/${SPACE}/repo`
  const spaceTarget = createMessageQueueTarget("space-session", spaceDirectory, "runtime-a")!
  const spaceKey = getMessageQueueKey(spaceTarget)
  const spaceSession = (items: ServerItem[]): ServerSession => ({ sessionId: "space-session", directory: spaceDirectory, items, sendingId: null })

  beforeEach(() => {
    useMessageQueueStore.getState().forgetQueue(spaceTarget)
  })

  test("its queue requests go to the space, and the space's answer settles the projection", async () => {
    respond = () => json({ revision: 1, session: spaceSession([serverItem("s1", "later")]) })
    await useMessageQueueStore.getState().addToQueue(spaceTarget, { content: "later", sendConfig: { providerID: "p", modelID: "m" } })
    useMessageQueueStore.getState().removeFromQueue(spaceTarget, "s1")
    await Promise.resolve()

    expect(calls.map((call) => [call.method, call.path, call.directory])).toEqual([
      ["POST", "/api/message-queue/sessions/space-session/items", spaceDirectory],
      ["DELETE", "/api/message-queue/sessions/space-session/items/s1", spaceDirectory],
    ])
  })

  test("the host's snapshot leaves a space's queue alone, and the space's snapshot leaves the host's", async () => {
    useMessageQueueStore.setState({
      queuedMessages: {
        [key]: [{ id: "h0", content: "host", text: "host", createdAt: 1 }],
        [spaceKey]: [{ id: "s0", content: "space", text: "space", createdAt: 1 }],
      },
    })
    respond = () => json({ revision: 9, sessions: [] })
    await useMessageQueueStore.getState().hydrate()
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toEqual([spaceKey])

    useMessageQueueStore.setState({ queuedMessages: { ...useMessageQueueStore.getState().queuedMessages, [key]: [{ id: "h1", content: "host", text: "host", createdAt: 1 }] } })
    respond = () => json({ revision: 2, sessions: [] })
    await useMessageQueueStore.getState().refreshSpaceQueue(SPACE)
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/message-queue", directory: `/spaces/${SPACE}` })
    expect(Object.keys(useMessageQueueStore.getState().queuedMessages)).toEqual([key])
  })

  test("a space that cannot be read keeps what was last known of its queue", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [spaceKey]: [{ id: "s0", content: "space", text: "space", createdAt: 1 }] } })
    respond = () => new Response("{}", { status: 503 })
    await useMessageQueueStore.getState().refreshSpaceQueue(SPACE)
    expect(useMessageQueueStore.getState().queuedMessages[spaceKey]?.map((m) => m.id)).toEqual(["s0"])
  })

  test("a change forwarded from the space applies with the space's own revisions, and only for that space", async () => {
    respond = () => json({ revision: 50, sessions: [] })
    await useMessageQueueStore.getState().hydrate()

    const fromSpace = (spaceId: string | undefined, revision: number, changed: ServerSession): MessageQueueUpdatedEvent => ({
      type: "openchamber:message-queue.updated",
      properties: { revision, session: changed, spaceId },
    })
    applyMessageQueueUpdatedEvent(fromSpace(SPACE, 1, spaceSession([serverItem("s1", "next")])), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[spaceKey]?.map((m) => m.id)).toEqual(["s1"])

    // Another space, or the host, does not speak for this space's session.
    applyMessageQueueUpdatedEvent(fromSpace("0f0f0f0f0f0f", 2, spaceSession([])), "runtime-a")
    applyMessageQueueUpdatedEvent(fromSpace(undefined, 51, spaceSession([])), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[spaceKey]?.map((m) => m.id)).toEqual(["s1"])

    applyMessageQueueUpdatedEvent(fromSpace(SPACE, 2, spaceSession([])), "runtime-a")
    expect(useMessageQueueStore.getState().queuedMessages[spaceKey]).toBeUndefined()
  })
})
