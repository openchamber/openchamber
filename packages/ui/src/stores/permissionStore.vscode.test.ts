import { beforeEach, describe, expect, mock, test } from "bun:test"

let reconcileDirectory: string | undefined
let reconcileShouldFail = false

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { enabled?: boolean }
    return new Response(JSON.stringify({ sessions: { root: body.enabled === true } }), { status: 200 })
  },
}))
mock.module("@/lib/desktop", () => ({ isVSCodeRuntime: () => true }))
mock.module("@/sync/sync-refs", () => ({ getAllSyncSessionMap: () => new Map() }))
mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => "/repo" }) },
}))
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: { getDirectory: () => "/fallback" },
}))
mock.module("@/sync/vscode-permission-auto-accept", () => ({
  reconcileVSCodePendingPermissions: async (directory?: string) => {
    reconcileDirectory = directory
    if (reconcileShouldFail) throw new Error("offline")
  },
}))

const { usePermissionStore } = await import("./permissionStore")

describe("permission store VS Code policy", () => {
  beforeEach(() => {
    reconcileDirectory = undefined
    reconcileShouldFail = false
    usePermissionStore.getState().reset()
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
})
