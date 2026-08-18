import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2"

import { opencodeClient } from "@/lib/opencode/client"
import { useGlobalSessionsStore } from "./useGlobalSessionsStore"

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

let listRequest: Deferred<Session[]>

// The store issues one inclusive (`archived: true`) paginated request per
// load/refresh scope and splits active/archived client-side, so restored
// sessions (`time.archived` falsy-but-present) stay visible in the active
// list. The mock serves that single request.
const sdk = {
  experimental: {
    session: {
      list: async () => ({
        data: await listRequest.promise,
        response: { headers: new Headers() },
      }),
    },
  },
} as unknown as OpencodeClient
const originalGetSdkClient = opencodeClient.getSdkClient

const session = (id: string, title = id, archived?: number): Session => ({
  id,
  title,
  time: { created: 1, updated: 1, ...(archived !== undefined ? { archived } : {}) },
} as Session)

describe("global session mutation reconciliation", () => {
  beforeEach(() => {
    listRequest = deferred<Session[]>()
    opencodeClient.getSdkClient = () => sdk
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  afterEach(() => {
    opencodeClient.getSdkClient = originalGetSdkClient
  })

  test("keeps a session created after a full load starts", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(session("created"))

    listRequest.resolve([])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["created"])
  })

  test("does not resurrect a session deleted after a full load starts", async () => {
    const stale = session("deleted")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().removeSessions([stale.id])

    listRequest.resolve([stale])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })

  test("keeps an archive mutation newer than both list requests", async () => {
    const stale = session("archived")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().archiveSessions([stale.id], 10)

    listRequest.resolve([stale])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([])
    expect(useGlobalSessionsStore.getState().archivedSessions[0]?.time.archived).toBe(10)
  })

  test("keeps a newer title when an older response finishes last", async () => {
    const stale = session("updated", "Old")
    useGlobalSessionsStore.getState().applySnapshot([stale], [])
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(session("updated", "New"))

    listRequest.resolve([stale])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.title).toBe("New")
  })

  test("uses commit-time state when the load fails", async () => {
    const created = session("created")
    const loading = useGlobalSessionsStore.getState().loadSessions()
    useGlobalSessionsStore.getState().upsertSession(created)

    listRequest.reject(new Error("unavailable"))
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([created])
    expect(useGlobalSessionsStore.getState().status).toBe("error")
  })

  test("splits a restored session into the active list", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()

    listRequest.resolve([session("active"), session("archived", "archived", 5), session("restored", "restored", 0)])
    await loading

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["active", "restored"])
    expect(useGlobalSessionsStore.getState().archivedSessions.map((item) => item.id)).toEqual(["archived"])
    expect(useGlobalSessionsStore.getState().status).toBe("ready")
  })

  test("does not undo a move while refreshing the source directory", async () => {
    const source = { ...session("moved"), directory: "/source" } as Session
    const destination = { ...source, directory: "/destination" } as Session
    useGlobalSessionsStore.getState().applySnapshot([source], [])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession(destination)

    listRequest.resolve([source])
    await refreshing

    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/source")).toBe(undefined)
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get("/destination")?.[0]?.id).toBe("moved")
  })

  test("keeps a restore mutation newer than the directory refresh", async () => {
    const archived = { ...session("restored", "restored", 5), directory: "/source" } as Session
    useGlobalSessionsStore.getState().applySnapshot([], [archived])
    const refreshing = useGlobalSessionsStore.getState().refreshSessionsForDirectories(["/source"])
    useGlobalSessionsStore.getState().upsertSession({ ...archived, time: { ...archived.time, archived: 0 } })

    // The server still reports the pre-restore row for this directory.
    listRequest.resolve([archived])
    await refreshing

    expect(useGlobalSessionsStore.getState().activeSessions.map((item) => item.id)).toEqual(["restored"])
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([])
  })
})
