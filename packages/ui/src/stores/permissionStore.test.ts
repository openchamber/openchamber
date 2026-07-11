import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

type PendingPermission = {
  id: string
  sessionID: string
}

const permissionGetCalls: Array<{ sessionID: string; requestID: string; directory?: string | null }> = []
const permissionReplyCalls: Array<{ requestID: string; reply: string; directory?: string }> = []
const runtimeFetchCalls: Array<{ sessionId: string; enabled: boolean }> = []

let syncSessions: Session[] = []
let sessionDirectoryMap = new Map<string, string | null>()
let syncChildStores = new Map<string, { getState: () => { permission?: Record<string, PendingPermission[]>; session?: Session[]; message?: Record<string, unknown>; session_status?: Record<string, unknown>; question?: Record<string, unknown> } }>()
let currentDirectory: string | undefined = undefined
let pendingFromApi: Array<{ id: string; sessionID: string }> = []

mock.module("./utils/safeStorage", () => ({
  createDeferredSafeJSONStorage: () => ({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }),
}))

mock.module("@/sync/sync-refs", () => ({
  setSyncRefs: () => undefined,
  getAllSyncSessions: () => syncSessions,
  getSyncChildStores: () => ({
    children: syncChildStores,
  }),
  getDirectoryState: () => undefined,
  getSyncConfig: () => undefined,
  subscribeToSyncConfigChanges: () => () => undefined,
  registerSessionDirectory: () => undefined,
  emitSyncConfigChanged: () => undefined,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncSessionMaterializationStatus: () => undefined,
  getSyncParts: () => [],
  getSyncSessionStatus: () => undefined,
}))

mock.module("./sync-refs", () => ({
  setSyncRefs: () => undefined,
  getAllSyncSessions: () => syncSessions,
  getSyncChildStores: () => ({
    children: syncChildStores,
  }),
  getDirectoryState: () => undefined,
  getSyncConfig: () => undefined,
  subscribeToSyncConfigChanges: () => () => undefined,
  registerSessionDirectory: () => undefined,
  emitSyncConfigChanged: () => undefined,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncSessionMaterializationStatus: () => undefined,
  getSyncParts: () => [],
  getSyncSessionStatus: () => undefined,
}))

mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: (sessionID: string) => sessionDirectoryMap.get(sessionID) ?? null,
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      probeConnection: async () => true,
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: () => undefined,
    }),
  },
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock((_url: string, options?: { body?: string }) => {
    const body = JSON.parse(options?.body ?? "{}") as { sessionId?: string; enabled?: boolean }
    runtimeFetchCalls.push({
      sessionId: body.sessionId ?? "",
      enabled: body.enabled === true,
    })
    return Promise.resolve(new Response(null, { status: 204 }))
  }),
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => currentDirectory,
    listPendingPermissions: mock(() => Promise.resolve(pendingFromApi)),
    getSessionPermissionRequest: mock((sessionID: string, requestID: string, directory?: string | null) => {
      permissionGetCalls.push({ sessionID, requestID, directory })
      return Promise.resolve({ id: requestID, sessionID, action: "edit", resources: [] })
    }),
    getScopedSdkClient: () => ({
      permission: {
        reply: mock((params: { requestID: string; reply: string; directory?: string }) => {
          permissionReplyCalls.push(params)
          return Promise.resolve({ data: true })
        }),
      },
      session: {
        get: mock(() => Promise.resolve({ data: undefined })),
      },
    }),
    getSdkClient: () => ({
      session: {
        get: mock(() => Promise.resolve({ data: undefined })),
      },
    }),
  },
}))

const { setActionRefs } = await import("@/sync/session-actions")
const { usePermissionStore } = await import("./permissionStore")

describe("usePermissionStore", () => {
  beforeEach(() => {
    permissionGetCalls.length = 0
    permissionReplyCalls.length = 0
    runtimeFetchCalls.length = 0
    syncSessions = []
    sessionDirectoryMap = new Map()
    syncChildStores = new Map()
    currentDirectory = undefined
    pendingFromApi = []

    usePermissionStore.setState({ autoAccept: {} })
    setActionRefs(
      {} as OpencodeClient,
      {
        children: syncChildStores,
        ensureChild: (directory: string) => {
          const store = syncChildStores.get(directory)
          if (!store) throw new Error(`Missing store for ${directory}`)
          return store
        },
        getChild: (directory: string) => syncChildStores.get(directory),
      } as unknown as import("@/sync/child-store").ChildStoreManager,
      () => currentDirectory ?? "",
    )
  })

  test("setSessionAutoAccept preserves child-session directory during multi-directory sweep", async () => {
    syncSessions = [
      { id: "root", time: { created: 1 } } as Session,
      { id: "child", parentID: "root", time: { created: 2 } } as Session,
    ]
    currentDirectory = "/repo-root"
    sessionDirectoryMap = new Map([
      ["root", "/repo-root"],
      ["child", "/repo-child"],
    ])
    syncChildStores = new Map([
      [
        "/repo-child",
        {
          getState: () => ({
            permission: {
              child: [{ id: "perm-child", sessionID: "child" }],
            },
            session: syncSessions,
            message: {},
            session_status: {},
            question: {},
          }),
        },
      ],
    ])
    setActionRefs(
      {} as OpencodeClient,
      {
        children: syncChildStores,
        ensureChild: (directory: string) => {
          const store = syncChildStores.get(directory)
          if (!store) throw new Error(`Missing store for ${directory}`)
          return store
        },
        getChild: (directory: string) => syncChildStores.get(directory),
      } as unknown as import("@/sync/child-store").ChildStoreManager,
      () => currentDirectory ?? "",
    )

    await usePermissionStore.getState().setSessionAutoAccept("root", true)

    expect(permissionGetCalls.find((call) => call.requestID === "perm-child")).toEqual({
      sessionID: "child",
      requestID: "perm-child",
      directory: "/repo-child",
    })
    expect(permissionReplyCalls.find((call) => call.requestID === "perm-child")).toEqual({
      requestID: "perm-child",
      reply: "once",
      directory: "/repo-child",
    })
  })
})
