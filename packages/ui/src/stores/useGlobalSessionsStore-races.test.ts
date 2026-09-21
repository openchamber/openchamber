import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
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

describe("paginated global session load", () => {
  const PAGE_SIZE = 500
  let secondPage: Deferred<Session[]>
  let listCalls: number

  const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({
    ...session(`page1-${index}`),
    time: { created: 1, updated: 1000 - index },
  }) as Session)

  const pagedSdk = {
    experimental: {
      session: {
        list: async (options: { cursor?: number }) => {
          listCalls += 1
          return {
            data: options.cursor === undefined ? firstPage : await secondPage.promise,
            response: { headers: new Headers() },
          }
        },
      },
    },
  } as unknown as OpencodeClient

  const until = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("condition never became true")
  }

  beforeEach(() => {
    secondPage = deferred<Session[]>()
    listCalls = 0
    opencodeClient.getSdkClient = () => pagedSdk
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  afterEach(() => {
    opencodeClient.getSdkClient = originalGetSdkClient
  })

  test("shows the first page before pagination finishes", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    await until(() => useGlobalSessionsStore.getState().activeSessions.length > 0)

    const partial = useGlobalSessionsStore.getState()
    expect(partial.activeSessions).toHaveLength(PAGE_SIZE)
    expect(partial.status).toBe("loading")
    expect(partial.hasLoaded).toBe(false)
    expect(listCalls).toBe(2)

    secondPage.resolve([{ ...session("page2-0"), time: { created: 1, updated: 400 } } as Session])
    await loading

    const complete = useGlobalSessionsStore.getState()
    expect(complete.activeSessions).toHaveLength(PAGE_SIZE + 1)
    expect(complete.activeSessions.some((item) => item.id === "page2-0")).toBe(true)
    expect(complete.status).toBe("ready")
    expect(complete.hasLoaded).toBe(true)
  })

  test("keeps the persisted seed visible while pagination continues", async () => {
    const seeded = session("seeded")
    useGlobalSessionsStore.getState().upsertSession(seeded)

    const loading = useGlobalSessionsStore.getState().loadSessions()
    await until(() => useGlobalSessionsStore.getState().activeSessions.length > 1)

    expect(useGlobalSessionsStore.getState().activeSessions.some((item) => item.id === "seeded")).toBe(true)

    secondPage.resolve([])
    await loading
  })

  test("keeps an archive made between the first page and completion", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    await until(() => useGlobalSessionsStore.getState().activeSessions.length > 0)

    useGlobalSessionsStore.getState().archiveSessions(["page1-0"], 42)

    secondPage.resolve([])
    await loading

    const state = useGlobalSessionsStore.getState()
    expect(state.activeSessions.some((item) => item.id === "page1-0")).toBe(false)
    expect(state.archivedSessions.map((item) => item.id)).toEqual(["page1-0"])
    expect(state.status).toBe("ready")
  })

  test("keeps the first page when a later page fails", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    await until(() => useGlobalSessionsStore.getState().activeSessions.length > 0)

    secondPage.reject(new Error("unavailable"))
    await loading

    const state = useGlobalSessionsStore.getState()
    expect(state.activeSessions).toHaveLength(PAGE_SIZE)
    expect(state.status).toBe("error")
  })

  test("drops the pages when the runtime switches mid-load", async () => {
    const loading = useGlobalSessionsStore.getState().loadSessions()
    await until(() => useGlobalSessionsStore.getState().activeSessions.length > 0)

    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    secondPage.resolve([{ ...session("page2-0"), time: { created: 1, updated: 400 } } as Session])
    await loading

    const state = useGlobalSessionsStore.getState()
    expect(state.activeSessions).toEqual([])
    expect(state.archivedSessions).toEqual([])
    expect(state.hasLoaded).toBe(false)
    expect(state.status).toBe("idle")
  })
})

const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
await ensureChatsRootDirectory();
opencodeClient.getFilesystemHomeInfo = originalHomeInfo;
