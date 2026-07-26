import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let activeRequest: Deferred<Session[]>
let archivedRequest: Deferred<Session[]>

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: { getSdkClient: () => ({}), getDirectory: () => "/source", setDirectory: () => undefined },
}))
mock.module("@/stores/globalSessions", () => ({
  listGlobalSessionPages: (_sdk: unknown, options: { archived?: boolean }) => (
    options.archived ? archivedRequest.promise : activeRequest.promise
  ),
}))

const { useGlobalSessionsStore } = await import("./useGlobalSessionsStore")

const session = (id: string, title = id, archived?: number): Session => ({
  id,
  title,
  time: { created: 1, updated: 1, ...(archived ? { archived } : {}) },
} as Session)

describe("global session mutation reconciliation", () => {
  beforeEach(() => {
    activeRequest = deferred<Session[]>()
    archivedRequest = deferred<Session[]>()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  test("keeps a session created after a full load starts", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(session("created"))

    activeRequest.resolve([])
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["created"])
  })

  test("keeps a newer direct-only disposable session across a stale full snapshot", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    const directOnly = {
      ...session("side"), directory: "/source",
      metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: "parent" } } },
    } as Session
    useGlobalSessionsStore.getState().upsertSession(directOnly)

    activeRequest.resolve([])
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().getSessionById("side")).toEqual(directOnly)
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
  })

  test("does not resurrect a session deleted after a full load starts", async () => {
    const stale = session("deleted")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().removeSessions([stale.id])

    activeRequest.resolve([stale])
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })

  test("keeps an archive mutation newer than both list requests", async () => {
    const stale = session("archived")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().archiveSessions([stale.id], 10)

    activeRequest.resolve([stale])
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions[0]?.time.archived).toBe(10)
  })

  test("keeps a newer title when an older response finishes last", async () => {
    const stale = session("updated", "Old")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(session("updated", "New"))

    activeRequest.resolve([stale])
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.title).toBe("New")
  })

  test("uses commit-time state when one side of the load fails", async () => {
    const created = session("created")
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(created)

    activeRequest.reject(new Error("unavailable"))
    archivedRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([created])
    expect(useGlobalSessionsStore.getState().status).toBe("error")
  })

  test("does not undo a move while refreshing the source directory", async () => {
    const source = { ...session("moved"), directory: "/source" } as Session
    const destination = { ...source, directory: "/destination" } as Session
    useGlobalSessionsStore.getState().applySnapshot([source], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(destination)

    activeRequest.resolve([source])
    archivedRequest.resolve([])
    await refreshing

    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/source")).toBe(undefined)
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/destination")?.[0]?.id).toBe("moved")
  })
})
