import { beforeEach, describe, expect, mock, test } from "bun:test"
import { selectInputHistoryEntries, useInputHistoryStore } from "./useInputHistoryStore"
import type { AttachedFile } from "./types/sessionTypes"
import type { MessageQueueUpdatedEvent } from "./messageQueueStore"

type FetchCall = { path: string; method: string; body: ReturnType<typeof JSON.parse> }
let calls: FetchCall[] = []
let activeRuntimeKey = "runtime-a"
let respond: (call: FetchCall) => Response = () => new Response("{}", { status: 200 })

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    const call = {
      path,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
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

    expect(calls[0]).toEqual({
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

  test("takeForSend without an id takes everything the server is not already sending", async () => {
    respond = () => json({ revision: 8, session: session([serverItem("q1", "in flight")], "q1"), items: [serverItem("q2", "second")] })
    const taken = await useMessageQueueStore.getState().takeForSend(target)

    expect(calls[0]?.path).toBe("/api/message-queue/sessions/session-1/take")
    expect(calls[0]?.method).toBe("POST")
    expect(taken.map((m) => m.content)).toEqual(["second"])
    expect(useMessageQueueStore.getState().queuedMessages[key]?.map((m) => m.id)).toEqual(["q1"])
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
    expect(calls[0]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1/items/q1", body: undefined })

    respond = () => json({ revision: 11, session: session([]) })
    useMessageQueueStore.getState().clearQueue(target)
    expect(useMessageQueueStore.getState().queuedMessages[key]).toBe(undefined)
    await Promise.resolve()
    expect(calls[1]).toEqual({ method: "DELETE", path: "/api/message-queue/sessions/session-1", body: undefined })
  })

  test("reorderQueue sends the complete new order", async () => {
    useMessageQueueStore.setState({ queuedMessages: { [key]: [{ id: "q1", content: "a", text: "a", createdAt: 1 }, { id: "q2", content: "b", text: "b", createdAt: 2 }] } })
    respond = () => json({ revision: 12, session: session([serverItem("q2", "b"), serverItem("q1", "a")]) })
    useMessageQueueStore.getState().reorderQueue(target, "q2", "q1")
    await Promise.resolve()
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/message-queue/sessions/session-1/order", body: { itemIds: ["q2", "q1"] } })
  })
})
