import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

let reconcileDirectory: string | undefined
let reconcileShouldFail = false

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { enabled?: boolean }
    if (path === "/api/permission-auto-accept/default") {
      return new Response(JSON.stringify({ default: body.enabled === true, sessions: { root: false } }), { status: 200 })
    }
    return new Response(JSON.stringify({ default: false, sessions: { root: body.enabled === true } }), { status: 200 })
  },
}))
mock.module("@/sync/sync-refs", () => ({
  emitSyncConfigChanged: () => undefined,
  getAllSyncSessionMap: () => new Map(),
  getAllSyncSessions: () => [],
  getDirectoryState: () => undefined,
  getSyncChildStores: () => ({ children: new Map() }),
  getSyncConfig: () => undefined,
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getSyncSessionMaterializationStatus: () => ({ hasMessages: false, renderable: false, missingPartMessageIDs: [] }),
  getSyncSessionStatus: () => undefined,
  getSyncSessions: () => [],
  registerSessionDirectory: () => undefined,
  setSyncRefs: () => undefined,
  subscribeToSyncConfigChanges: () => () => undefined,
}))
mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => "/repo" }) },
}))
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/fallback",
    getScopedSdkClient: () => ({}),
    listPendingPermissions: async () => [],
    listPendingQuestions: async () => [],
    setDirectory: () => undefined,
  },
}))

const {
  usePermissionStore,
  setPermissionStoreTestDependencies,
} = await import("./permissionStore")

describe("permission store VS Code policy", () => {
  beforeEach(() => {
    reconcileDirectory = undefined
    reconcileShouldFail = false
    usePermissionStore.getState().reset()
    setPermissionStoreTestDependencies({
      isVSCodeRuntime: () => true,
      reconcileVSCodePendingPermissions: async (directory?: string) => {
        reconcileDirectory = directory
        if (reconcileShouldFail) throw new Error("offline")
      },
    })
  })

  afterEach(() => {
    setPermissionStoreTestDependencies()
  })

  test("reconciles existing pending requests after enabling auto-accept", async () => {
    await usePermissionStore.getState().setSessionAutoAccept("root", true)
    await Promise.resolve()

    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true })
    expect(reconcileDirectory).toBe("/repo")
  })

  test("does not reconcile when disabling auto-accept", async () => {
    await usePermissionStore.getState().setSessionAutoAccept("root", false)

    expect(reconcileDirectory).toBe(undefined)
  })

  test("keeps a persisted toggle successful when pending reconciliation fails", async () => {
    reconcileShouldFail = true

    await usePermissionStore.getState().setSessionAutoAccept("root", true)
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true })
  })

  test("reconciles existing pending requests after enabling the global default", async () => {
    await usePermissionStore.getState().setDefaultAutoAccept(true)
    await Promise.resolve()

    expect(usePermissionStore.getState().defaultEnabled).toBe(true)
    expect(reconcileDirectory).toBe(undefined)
  })

  test("does not reconcile when disabling the global default", async () => {
    await usePermissionStore.getState().setDefaultAutoAccept(false)

    expect(usePermissionStore.getState().defaultEnabled).toBe(false)
    expect(reconcileDirectory).toBe(undefined)
  })
})
