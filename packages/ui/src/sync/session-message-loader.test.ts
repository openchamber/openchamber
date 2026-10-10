import { describe, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { Message, Part } from "@/lib/opencode/model"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import {
  createFirstVisibleSessionPerformanceTracker,
  startSessionLoadPerformanceEvent,
} from "./session-load-performance"

const createRecord = (sessionID: string, id = "msg_1", created = 1) => ({
  info: { id, sessionID, role: "user", time: { created } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello" }] as Part[],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

const response = (items: ReturnType<typeof createRecord>[], cursor?: string): MessagePage => ({
  items,
  cursor: cursor ? { next: cursor } : {},
})

/** The adapter rejects; the loader only ever sees a thrown error with a status. */
const failure = (status: number, message: string): never => {
  throw Object.assign(new Error(`session.messages failed (${status}): ${message}`), { status })
}

type PageRequest = { sessionID: string; directory?: string; limit?: number; cursor?: string }

const createLoader = (getPage: (input: PageRequest) => Promise<MessagePage>) => {
  const childStores = new ChildStoreManager()
  const sdk = {
    getSessionMessages: (
      sessionID: string,
      options?: { limit?: number; cursor?: string },
      directory?: string | null,
    ) => getPage({ sessionID, directory: directory ?? undefined, limit: options?.limit, cursor: options?.cursor }),
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
  return { childStores, loader }
}

describe("SessionMessageLoader", () => {
  test("opens a confirmed new session without fetching history", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return failure(404, "not found")
    })
    const target = { directory: "/created-repo", sessionID: "session-created" }

    loader.initializeCreatedSession(target)
    await loader.ensure(target, { reason: "navigation" })
    await loader.ensure(target, { reason: "reactive" })

    expect(calls).toBe(0)
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true, complete: true })
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])

    const record = createRecord(target.sessionID)
    loader.optimisticAdd({ ...target, message: record.info, parts: record.parts })
    await loader.ensure(target)
    expect(calls).toBe(0)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])

    // Explicit recovery still reaches the server and exposes a real failure.
    await loader.ensure(target, { force: true })
    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])
    loader.dispose()
    childStores.disposeAll()
  })

  test("creation supersedes an early history failure without losing the first prompt", async () => {
    const pending = deferred<MessagePage>()
    const { childStores, loader } = createLoader(() => pending.promise)
    const target = { directory: "/created-race", sessionID: "session-created" }
    const earlyLoad = loader.ensure(target)

    loader.initializeCreatedSession(target)
    const record = createRecord(target.sessionID)
    loader.optimisticAdd({ ...target, message: record.info, parts: record.parts })
    pending.reject(Object.assign(new Error("session.messages failed (404): not found"), { status: 404 }))
    await earlyLoad

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])
    expect(childStores.getChild(target.directory)?.getState().part[record.info.id]).toEqual(record.parts)
    loader.dispose()
    childStores.disposeAll()
  })

  test("creation preserves messages and history coverage received before its response", async () => {
    const record = createRecord("session-created")
    const { childStores, loader } = createLoader(async () => response([record], "older-cursor"))
    const target = { directory: "/created-events", sessionID: "session-created" }
    await loader.ensure(target)
    const before = childStores.getChild(target.directory)?.getState()
    const coverage = loader.getSnapshot(target)

    loader.initializeCreatedSession(target)

    expect(childStores.getChild(target.directory)?.getState()).toBe(before)
    expect(loader.getSnapshot(target)).toBe(coverage)
    loader.dispose()
    childStores.disposeAll()
  })

  test("deduplicates navigation and reactive loading for the same target", async () => {
    const pending = deferred<MessagePage>()
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return pending.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const navigation = loader.ensure(target, { reason: "navigation" })
    const reactive = loader.ensure(target, { reason: "reactive" })
    expect(calls).toBe(1)

    pending.resolve(response([createRecord(target.sessionID)]))
    await Promise.all([navigation, reactive])

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("leaves older history loading to explicit viewport demand", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      // Ten prompts satisfy the cold-navigation turn target without expansion.
      return cursor
        ? response([createRecord(sessionID, "msg_older", 1)])
        : response(Array.from({ length: 10 }, (_, index) => createRecord(sessionID, `msg_${index + 2}`, index + 2)), "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { reason: "prefetch" })
    await Promise.resolve()

    expect(calls).toEqual([{ limit: 100, cursor: undefined }])
    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")

    await loader.loadOlder(target)

    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "older-cursor" },
    ])
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_older", ...Array.from({ length: 10 }, (_, index) => `msg_${index + 2}`)])
    loader.dispose()
    childStores.disposeAll()
  })

  test("keeps a post-rollover tail after legacy messages for shared runtime identities", async () => {
    const runtimes = ["web", "desktop", "vscode", "mobile"]
    for (const runtimeKey of runtimes) {
      const childStores = new ChildStoreManager()
      const sdk = {
        getSessionMessages: async (sessionID: string) => response([
          createRecord(sessionID, "msg_000000000000Current", 200),
          createRecord(sessionID, "msg_ffffffffffffLegacy", 100),
        ]),
      }
      const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey })
      const target = { directory: `/repo-${runtimeKey}`, sessionID: "session-a" }

      await loader.ensure(target)

      expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
        .toEqual(["msg_ffffffffffffLegacy", "msg_000000000000Current"])
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("loads every history page for an explicit complete-history request", async () => {
    const calls: Array<{ cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (!cursor) return response([createRecord(sessionID, "msg_latest")], "cursor-2")
      if (cursor === "cursor-2") return response([createRecord(sessionID, "msg_middle")], "cursor-1")
      return response([createRecord(sessionID, "msg_oldest")])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadComplete(target)

    expect(calls).toEqual([
      { cursor: undefined },
      { cursor: "cursor-2" },
      { cursor: "cursor-1" },
    ])
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when its initial load fails", async () => {
    const { childStores, loader } = createLoader(async () => failure(400, "rejected"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): rejected")

    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when an older page fails", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => cursor
      ? failure(400, "older rejected")
      : response([createRecord(sessionID)], "older-cursor"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): older rejected")

    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")
    loader.dispose()
    childStores.disposeAll()
  })

  test("fetches authoritative coverage when renderable messages have no loader metadata", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached").info] },
    })

    await loader.loadComplete(target)

    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).complete).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects repeated pagination cursors instead of looping forever", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls += 1
      if (!cursor) return response([createRecord(sessionID, "latest")], "cursor-a")
      if (cursor === "cursor-a") return response([createRecord(sessionID, "middle")], "cursor-b")
      return response([createRecord(sessionID, "older")], "cursor-a")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("Session history pagination made no progress")

    expect(calls).toBe(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a requested tail refresh after an older in-flight load", async () => {
    const initial = deferred<MessagePage>()
    const refresh = deferred<MessagePage>()
    let calls = 0
    const limits: number[] = []
    const { childStores, loader } = createLoader(async ({ limit }) => {
      calls += 1
      limits.push(limit ?? 0)
      return calls === 1 ? initial.promise : refresh.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target, { reason: "navigation" })
    const refreshing = loader.refreshTail(target, 30)
    const duplicateRefresh = loader.refreshTail(target, 80)
    expect(calls).toBe(1)
    expect(duplicateRefresh).toBe(refreshing)

    initial.resolve(response([createRecord(target.sessionID, "msg_1")]))
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(limits).toEqual([100, 80])

    refresh.resolve(response([createRecord(target.sessionID, "msg_2")]))
    await Promise.all([refreshing, duplicateRefresh])

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("a tail refresh replaces the optimistic prompt's client clock with the server's", async () => {
    // The browser's clock runs ahead of the server's: the prompt was stamped
    // 10s, the server recorded it at 1s and its reply at 1.5s.
    const prompt = createRecord("session-skew", "msg_prompt", 10_000)
    const serverPrompt = createRecord("session-skew", "msg_prompt", 1_000)
    const reply = {
      info: { id: "msg_reply", sessionID: "session-skew", role: "assistant", time: { created: 1_500, completed: 2_000 } } as Message,
      parts: [{ id: "part_reply", messageID: "msg_reply", sessionID: "session-skew", type: "text", text: "answer" }] as Part[],
    }
    const { childStores, loader } = createLoader(async () => response([serverPrompt, reply]))
    const target = { directory: "/remote", sessionID: "session-skew" }
    loader.initializeCreatedSession(target)
    loader.optimisticAdd({ ...target, message: prompt.info, parts: prompt.parts })

    await loader.refreshTail(target, 30)

    const messages = childStores.getChild(target.directory)?.getState().message[target.sessionID]
    expect(messages?.map((message) => [message.id, message.time.created])).toEqual([["msg_prompt", 1_000], ["msg_reply", 1_500]])
    loader.dispose()
    childStores.disposeAll()
  })

  test("a tail refresh keeps a prompt a live event already replaced", async () => {
    const prompt = createRecord("session-live", "msg_prompt", 10_000)
    const { childStores, loader } = createLoader(async () => response([createRecord("session-live", "msg_prompt", 1_000)]))
    const target = { directory: "/remote", sessionID: "session-live" }
    loader.initializeCreatedSession(target)
    loader.optimisticAdd({ ...target, message: prompt.info, parts: prompt.parts })
    const store = childStores.getChild(target.directory)!
    const live = { ...prompt.info, time: { created: 1_200 } }
    store.setState({ message: { ...store.getState().message, [target.sessionID]: [live] } })

    await loader.refreshTail(target, 30)

    expect(store.getState().message[target.sessionID]).toEqual([live])
    loader.dispose()
    childStores.disposeAll()
  })

  test("preserves complete history coverage across a tail refresh", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1
        ? response([createRecord(sessionID, "msg_1")])
        : response([createRecord(sessionID, "msg_1"), createRecord(sessionID, "msg_2", 2)], "stale-tail-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)

    await loader.refreshTail(target, 2)

    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not deduplicate identical session IDs across directories", async () => {
    const calls: string[] = []
    const { childStores, loader } = createLoader(async ({ directory, sessionID }) => {
      calls.push(directory ?? "")
      return response([createRecord(sessionID)])
    })

    await Promise.all([
      loader.ensure({ directory: "/repo-a", sessionID: "shared" }),
      loader.ensure({ directory: "/repo-b", sessionID: "shared" }),
    ])

    expect(calls.sort()).toEqual(["/repo-a", "/repo-b"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("loads older history with the selected directory's cursor for duplicate session IDs", async () => {
    const providerDirectory = "/repo/provider"
    const selectedDirectory = "/repo/selected-worktree"
    const sessionID = "shared"
    const calls: Array<{ directory?: string; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ directory, cursor }) => {
      calls.push({ directory, cursor })
      return cursor
        ? response([createRecord(sessionID, `older-${directory}`)])
        : response([createRecord(sessionID, `latest-${directory}`)], `${directory}-cursor`)
    })

    await Promise.all([
      loader.ensure({ directory: providerDirectory, sessionID }),
      loader.ensure({ directory: selectedDirectory, sessionID }),
    ])

    // Cold navigation extends each directory's window through its own cursor.
    expect(calls.filter((call) => call.cursor)).toEqual([
      { directory: providerDirectory, cursor: `${providerDirectory}-cursor` },
      { directory: selectedDirectory, cursor: `${selectedDirectory}-cursor` },
    ])
    expect(loader.getSnapshot({ directory: selectedDirectory, sessionID }).complete).toBe(true)
    calls.length = 0
    await loader.loadOlder({ directory: selectedDirectory, sessionID })
    expect(calls).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("exposes a retryable error without clearing an existing snapshot", async () => {
    let fail = true
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      if (fail) return failure(400, "rejected")
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: [{ id: "cached", sessionID: target.sessionID, role: "user", time: { created: 0 } } as Message] } })

    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("error")
    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(400)
    expect(store.getState().message[target.sessionID]?.[0]?.id).toBe("cached")

    fail = false
    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })

  test("propagates a zero response status on SDK errors", async () => {
    const { childStores, loader } = createLoader(async () => failure(0, "network rejected"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { force: true })

    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(0)
    loader.dispose()
    childStores.disposeAll()
  })

  test("prevents an evicted in-flight request from repopulating the store", async () => {
    const pending = deferred<MessagePage>()
    const { childStores, loader } = createLoader(async () => pending.promise)
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target)
    loader.invalidateSession(target)
    pending.resolve(response([createRecord(target.sessionID)]))
    await loading

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBe(undefined)
    expect(loader.getSnapshot(target).status).toBe("idle")
    loader.dispose()
    childStores.disposeAll()
  })

  test("treats an empty successful response as resolved authoritative state", async () => {
    const { childStores, loader } = createLoader(async () => response([]))
    const target = { directory: "/repo", sessionID: "empty" }

    await loader.ensure(target)

    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a transient page failure instead of treating it as an empty snapshot", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1 ? failure(503, "unavailable") : response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)

    expect(calls).toBe(2)
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("reports retries and every downloaded initial expansion record", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      location: { search: "" },
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    const target = { directory: "/repo", sessionID: "session-a" }
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      if (calls === 1) return failure(503, "unavailable")
      if (calls === 2) {
        const assistant = createRecord(target.sessionID, "msg_assistant")
        assistant.info = { ...assistant.info, role: "assistant" } as Message
        return response([assistant], "older")
      }
      return response([createRecord(target.sessionID, "msg_user")])
    })

    try {
      await loader.ensure(target)

      const events = diagnosticWindow.__openchamberSessionLoadPerformance?.events ?? []
      const initialEvent = events.find((event) => event.operation === "session-messages.initial")
      const pageEvents = events.filter((event) => event.operation === "session-messages.page")
      expect(calls).toBe(3)
      // The first page holds no prompt: one maximal page reads back to it.
      expect(pageEvents.map((event) => event.requestLimit)).toEqual([100, 200])
      expect(pageEvents.map((event) => event.cursorPresent)).toEqual([false, true])
      expect(pageEvents.map((event) => event.recordCount)).toEqual([1, 1])
      expect(initialEvent?.outcome).toBe("complete")
      expect(initialEvent?.retryCount).toBe(1)
      expect(initialEvent?.recordCount).toBe(2)
      expect("runtimeKey" in initialEvent!).toBe(false)
      expect("directory" in initialEvent!).toBe(false)
      expect("sessionID" in initialEvent!).toBe(false)
    } finally {
      loader.dispose()
      childStores.disposeAll()
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})

/**
 * A session's history on a fake server: records oldest first, served newest
 * first in cursor pages the way OpenCode does. Every request is recorded.
 */
const createHistoryServer = (sessionID: string) => {
  const records: ReturnType<typeof createRecord>[] = []
  const requests: Array<{ limit: number; cursor?: string; records: number }> = []
  const append = (count: number, promptEvery: number) => {
    for (let index = 0; index < count; index += 1) {
      const position = records.length
      const record = createRecord(sessionID, `msg_${String(position).padStart(5, "0")}`, position + 1)
      if (position % promptEvery !== 0) record.info = { ...record.info, role: "assistant", time: { created: position + 1, completed: position + 1 } } as Message
      records.push(record)
    }
  }
  const getPage = async ({ limit, cursor }: PageRequest): Promise<MessagePage> => {
    if (limit === undefined || limit > 200) return failure(400, "limit out of range")
    const end = cursor === undefined ? records.length : Number(cursor)
    const start = Math.max(0, end - limit)
    const items = records.slice(start, end)
    requests.push({ limit, cursor, records: items.length })
    return response(items, start > 0 ? String(start) : undefined)
  }
  return { records, requests, append, getPage }
}

const messageIDs = (childStores: ChildStoreManager, target: { directory: string; sessionID: string }) => (
  childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id) ?? []
)

describe("cached transcripts after a stream gap", () => {
  test("open renders the cache at once and refreshes its tail in the background", async () => {
    const target = { directory: "/repo", sessionID: "session-gap" }
    const server = createHistoryServer(target.sessionID)
    server.append(20, 4)
    let failing = false
    const { childStores, loader } = createLoader((input) => failing ? Promise.resolve(failure(400, "rejected")) : server.getPage(input))
    await loader.ensure(target, { reason: "navigation" })
    expect(server.requests.length).toBe(1)

    // No gap: reopening is served from the cache.
    await loader.ensure(target, { reason: "navigation" })
    expect(loader.revalidateIfStale(target)).toBe(false)
    expect(server.requests.length).toBe(1)

    // Another client continued the session while the stream was down.
    server.append(5, 4)
    loader.markHistoryStale()
    const before = messageIDs(childStores, target)
    const opened = loader.ensure(target, { reason: "navigation" })
    // The cached transcript is still what is on screen while the tail loads.
    expect(messageIDs(childStores, target)).toEqual(before)
    await opened
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(server.requests.slice(1).map((request) => request.limit)).toEqual([30])
    expect(messageIDs(childStores, target)).toEqual(server.records.map((record) => record.info.id))
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", complete: true })

    // Confirmed: the next open needs no request.
    await loader.ensure(target, { reason: "navigation" })
    expect(server.requests.length).toBe(2)

    // A failed refresh keeps the cached records and the mark.
    loader.markHistoryStale()
    failing = true
    const cached = childStores.getChild(target.directory)?.getState().message[target.sessionID]
    expect(loader.revalidateIfStale(target)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBe(cached)
    failing = false
    expect(loader.revalidateIfStale(target)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(loader.revalidateIfStale(target)).toBe(false)
    loader.dispose()
    childStores.disposeAll()
  })

  test("prefetch never revalidates a stale cache", async () => {
    const target = { directory: "/repo", sessionID: "session-prefetch" }
    const server = createHistoryServer(target.sessionID)
    server.append(8, 4)
    const { childStores, loader } = createLoader(server.getPage)
    await loader.ensure(target)
    loader.markHistoryStale()
    await loader.prefetch(target)
    expect(server.requests.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("a tail that does not reach the cache reads back until it joins, leaving no hole", async () => {
    const target = { directory: "/repo", sessionID: "session-join" }
    const server = createHistoryServer(target.sessionID)
    server.append(12, 6)
    const { childStores, loader } = createLoader(server.getPage)
    await loader.ensure(target)
    // 45 records with one long-running turn: the 30-record tail misses the cache.
    server.append(45, 100)
    loader.markHistoryStale()
    loader.revalidateIfStale(target)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(server.requests.slice(1).map((request) => request.cursor === undefined)).toEqual([true, false])
    expect(messageIDs(childStores, target)).toEqual(server.records.map((record) => record.info.id))
    expect(loader.getSnapshot(target).complete).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("a record that arrived live after the gap does not count as joining the cache", async () => {
    const target = { directory: "/repo", sessionID: "session-live-after-gap" }
    const server = createHistoryServer(target.sessionID)
    server.append(50, 50)
    const { childStores, loader } = createLoader(server.getPage)
    await loader.ensure(target)
    // The stream drops; another client adds 50 records nobody sees.
    loader.markHistoryStale()
    server.append(50, 100)
    // The stream is back and delivers the next record live.
    server.append(1, 100)
    const live = server.records[server.records.length - 1]
    const store = childStores.getChild(target.directory)
    const current = store?.getState()
    if (!store || !current) throw new Error("store missing")
    store.setState({
      message: { ...current.message, [target.sessionID]: [...(current.message[target.sessionID] ?? []), live.info] },
      part: { ...current.part, [live.info.id]: live.parts },
    })

    expect(loader.revalidateIfStale(target)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Before: the 30-record tail held the live record, merged as joined, and
    // left the 20 records behind it missing while the cache read as confirmed.
    expect(messageIDs(childStores, target)).toEqual(server.records.map((record) => record.info.id))
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", complete: true })
    expect(loader.revalidateIfStale(target)).toBe(false)
    loader.dispose()
    childStores.disposeAll()
  })

  test("a gap longer than the window replaces the cache with a fresh window", async () => {
    const target = { directory: "/repo", sessionID: "session-replace" }
    const server = createHistoryServer(target.sessionID)
    server.append(40, 4)
    const { childStores, loader } = createLoader(server.getPage)
    await loader.ensure(target)
    server.append(400, 10)
    loader.markHistoryStale()
    loader.revalidateIfStale(target)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const ids = messageIDs(childStores, target)
    const newest = server.records.slice(-ids.length).map((record) => record.info.id)
    expect(ids).toEqual(newest)
    expect(ids.includes(server.records[0].info.id)).toBe(false)
    const snapshot = loader.getSnapshot(target)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.cursor).toBe(String(server.records.length - ids.length))
    loader.dispose()
    childStores.disposeAll()
  })
})

describe("cold history window", () => {
  const coldOpen = async (count: number, promptEvery: number) => {
    const target = { directory: "/repo", sessionID: `session-${count}-${promptEvery}` }
    const server = createHistoryServer(target.sessionID)
    server.append(count, promptEvery)
    const { childStores, loader } = createLoader(server.getPage)
    await loader.ensure(target, { reason: "navigation" })
    const held = messageIDs(childStores, target)
    const turns = childStores.getChild(target.directory)?.getState().message[target.sessionID]
      ?.filter((message) => message.role === "user").length ?? 0
    loader.dispose()
    childStores.disposeAll()
    return { requests: server.requests, held: held.length, turns }
  }

  // Before: 100-record pages one at a time.
  test("sizes the extension from turn density instead of reading 100 records at a time", async () => {
    // Before: [100, 100, 100], 3 serial requests for the same 300 records.
    const sparse = await coldOpen(600, 25)
    expect(sparse.requests.map((request) => request.limit)).toEqual([100, 200])
    expect(sparse.held).toBe(300)
    expect(sparse.turns).toBeGreaterThanOrEqual(10)

    // Before: [100, 100], 200 records. Eight prompts in the first page size
    // the extension to the two turns still missing.
    const medium = await coldOpen(600, 12)
    expect(medium.requests.map((request) => request.limit)).toEqual([100, 50])
    expect(medium.held).toBe(150)
    expect(medium.turns).toBeGreaterThanOrEqual(10)
  })

  test("a dense session still needs one request", async () => {
    const dense = await coldOpen(600, 5)
    expect(dense.requests.map((request) => request.limit)).toEqual([100])
  })

  test("a last turn with no prompt in the first page reads one maximal page", async () => {
    // Before: [100, 100, 100] to reach the prompt 250 records back.
    const long = await coldOpen(600, 350)
    expect(long.requests.map((request) => request.limit)).toEqual([100, 200])
    expect(long.turns).toBeGreaterThanOrEqual(1)
  })

  test("never asks for more than OpenCode's page limit", async () => {
    const target = { directory: "/repo", sessionID: "session-large" }
    const server = createHistoryServer(target.sessionID)
    server.append(400, 2)
    const { childStores, loader } = createLoader(server.getPage)
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: server.records.slice(0, 250).map((record) => record.info) } })
    await loader.ensure(target, { force: true })
    expect(server.requests.every((request) => request.limit <= 200)).toBe(true)
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })
})

describe("session load performance diagnostics", () => {
  test("rejects unknown raw labels and preserves approved input counts", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    try {
      const finishUnknown = startSessionLoadPerformanceEvent({
        operation: "secret-operation",
        caller: "secret-caller",
        recordCount: 999,
      })
      finishUnknown("complete")
      const finishVisible = startSessionLoadPerformanceEvent({
        operation: "session-messages.visible",
        caller: "selected-session",
        recordCount: 30,
      })
      finishVisible("complete")

      expect(diagnosticWindow.__openchamberSessionLoadPerformance?.events).toHaveLength(1)
      const event = diagnosticWindow.__openchamberSessionLoadPerformance?.events[0]
      expect(event?.operation).toBe("session-messages.visible")
      expect(event?.caller).toBe("selected-session")
      expect(event?.recordCount).toBe(30)
      expect(JSON.stringify(diagnosticWindow.__openchamberSessionLoadPerformance)).not.toContain("secret")
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("does not schedule visibility work while diagnostics are disabled", () => {
    let requestedFrames = 0
    let visibleMarks = 0
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => false,
      requestFrame: () => {
        requestedFrames += 1
        return 1
      },
      cancelFrame: () => undefined,
      markVisible: () => {
        visibleMarks += 1
      },
    })

    tracker.schedule("session-a", 10)

    expect(requestedFrames).toBe(0)
    expect(visibleMarks).toBe(0)
  })

  test("reschedules an identity when its pending visibility frame was canceled", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    const cancelFirstA = tracker.schedule("session-a", 10)
    cancelFirstA()
    const cancelB = tracker.schedule("session-b", 10)
    cancelB()
    tracker.schedule("session-a", 10)
    frames.get(3)?.(0)

    expect(marks).toEqual(["visible"])
  })

  test("does not remeasure a completed identity after another session", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    tracker.schedule("session-a", 10)
    frames.get(1)?.(0)
    tracker.schedule("session-b", 10)
    frames.get(2)?.(0)
    tracker.schedule("session-a", 10)

    expect(nextFrame).toBe(2)
    expect(marks).toEqual(["visible", "visible"])
  })
})

describe("SessionMessageLoader before OpenCode is ready", () => {
  const createStartingLoader = (getPage: (sessionID: string) => Promise<MessagePage>) => {
    const childStores = new ChildStoreManager()
    const connection = deferred<void>()
    const startup = { starting: true }
    const signal = {
      isStarting: () => startup.starting,
      waitForConnection: () => connection.promise,
    }
    const sdk = { getSessionMessages: (sessionID: string) => getPage(sessionID) }
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" }, signal)
    const connect = () => {
      startup.starting = false
      connection.resolve()
    }
    return { childStores, loader, connect, connection }
  }

  test("a read that failed while OpenCode was starting stays loading and reads again once it connects", async () => {
    let calls = 0
    const { childStores, loader, connect } = createStartingLoader(async (sessionID) => {
      calls += 1
      if (calls === 1) return failure(400, "opencode is not ready")
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const navigation = loader.ensure(target, { reason: "navigation" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The failure is not shown and is not an empty transcript.
    expect(calls).toBe(1)
    expect(loader.getSnapshot(target)).toMatchObject({ status: "loading", resolved: false, error: null })
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBeUndefined()

    // The chat's reactive load joins the held one instead of reading again.
    const reactive = loader.ensure(target, { reason: "reactive" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)

    connect()
    await Promise.all([navigation, reactive])
    expect(calls).toBe(2)
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true })
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id)).toEqual(["msg_1"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("OpenCode not starting at all ends the held load in an error, not an empty session", async () => {
    let calls = 0
    const { childStores, loader, connection } = createStartingLoader(async () => {
      calls += 1
      return failure(400, "opencode is not ready")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const load = loader.ensure(target, { reason: "navigation" })
    connection.reject(new Error("OpenCode did not start in time."))
    await load
    expect(calls).toBe(1)
    expect(loader.getSnapshot(target)).toMatchObject({ status: "error", resolved: false })
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBeUndefined()
    loader.dispose()
    childStores.disposeAll()
  })

  test("a prefetch fails without waiting, unless the session is opened while it runs", async () => {
    let calls = 0
    const page = deferred<MessagePage>()
    const { childStores, loader, connect } = createStartingLoader(async (sessionID) => {
      calls += 1
      if (calls === 1) return failure(400, "opencode is not ready")
      if (calls === 2) return page.promise
      return response([createRecord(sessionID)])
    })
    const hovered = { directory: "/repo", sessionID: "session-hovered" }
    await loader.prefetch(hovered)
    expect(loader.getSnapshot(hovered).status).toBe("error")

    const opened = { directory: "/repo", sessionID: "session-opened" }
    const prefetch = loader.prefetch(opened)
    const navigation = loader.ensure(opened, { reason: "navigation" })
    page.reject(Object.assign(new Error("opencode is not ready"), { status: 400 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loader.getSnapshot(opened).status).toBe("loading")

    connect()
    await Promise.all([prefetch, navigation])
    expect(calls).toBe(3)
    expect(loader.getSnapshot(opened)).toMatchObject({ status: "ready", resolved: true })
    loader.dispose()
    childStores.disposeAll()
  })

  test("a read that fails after OpenCode connected is an error at once", async () => {
    let calls = 0
    const { childStores, loader, connect } = createStartingLoader(async () => {
      calls += 1
      return failure(400, "rejected")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    connect()
    await loader.ensure(target, { reason: "navigation" })
    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).status).toBe("error")
    loader.dispose()
    childStores.disposeAll()
  })
})
