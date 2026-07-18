import { describe, expect, mock, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createVSCodePermissionAutoAcceptRuntime } from "./vscode-permission-auto-accept.ts"

const permission = { id: "perm-1", sessionID: "child" } as PermissionRequest
const session = (id: string, parentID?: string) => ({ id, parentID }) as Session

describe("VS Code permission auto-accept runtime", () => {
  test("loads missing child lineage and inherits the nearest enabled policy", async () => {
    let replyCalls = 0
    let getSessionCalls = 0
    const reply = mock(async () => { replyCalls += 1 })
    const getSession = mock(async (id: string) => {
      getSessionCalls += 1
      return session(id, id === "child" ? "root" : undefined)
    })
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: false, sessions: { root: true } }),
      getSessions: () => new Map(),
      getSession,
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply,
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission, "/repo")).toBe(true)
    expect(getSessionCalls).toBe(1)
    expect(replyCalls).toBe(1)
  })

  test("honors an explicit child disable over an enabled parent", async () => {
    let replyCalls = 0
    const reply = mock(async () => { replyCalls += 1 })
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: { root: true, child: false } }),
      getSessions: () => new Map([["child", session("child", "root")]]),
      getSession: async () => session("root"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply,
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("fails closed when lineage cannot be loaded", async () => {
    let replyCalls = 0
    const reply = mock(async () => { replyCalls += 1 })
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: { root: true } }),
      getSessions: () => new Map(),
      getSession: async () => { throw new Error("offline") },
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply,
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("deduplicates concurrent events and retries failed replies", async () => {
    let attempts = 0
    const reply = mock(async () => {
      attempts += 1
      if (attempts < 2) throw new Error("transient")
    })
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: false, sessions: { child: true } }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply,
      wait: async () => undefined,
    })

    const first = runtime.processPermission(permission)
    const second = runtime.processPermission(permission)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(attempts).toBe(2)
  })

  test("reconciles existing pending permissions immediately after enablement", async () => {
    const replied: string[] = []
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: false, sessions: { root: true, disabled: false } }),
      getSessions: () => new Map([
        ["child", session("child", "root")],
        ["disabled", session("disabled", "root")],
      ]),
      getSession: async (id) => session(id),
      listPendingPermissions: async () => [
        permission,
        { ...permission, id: "perm-disabled", sessionID: "disabled" },
      ],
      getPermissionState: async () => "ok",
      reply: async (_sessionId, requestId) => { replied.push(requestId) },
      wait: async () => undefined,
    })

    await runtime.reconcilePending("/repo")

    expect(replied).toEqual(["perm-1"])
  })

  test("reconciles pending permissions across authoritative known directories when enabling the global default", async () => {
    const requestedDirectories: Array<string | undefined> = []
    const replied: string[] = []
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map(),
      getSession: async (id) => session(id),
      getKnownDirectories: () => ["/workspace", "/workspace", "/nested"],
      listPendingPermissions: async (directory) => {
        requestedDirectories.push(directory)
        if (directory === "/workspace") {
          return [{ id: "perm-workspace", sessionID: "workspace-root" } as PermissionRequest]
        }
        if (directory === "/nested") {
          return [{ id: "perm-nested", sessionID: "nested-root" } as PermissionRequest]
        }
        return []
      },
      getPermissionState: async () => "ok",
      reply: async (_sessionId, requestId) => { replied.push(requestId) },
      wait: async () => undefined,
    })

    await runtime.reconcilePending()

    expect(requestedDirectories).toEqual(["/workspace", "/nested"])
    expect(replied).toEqual(["perm-workspace", "perm-nested"])
  })

  test("leaves failed directory reconciliation distinct from an empty success", async () => {
    const requestedDirectories: Array<string | undefined> = []
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map(),
      getSession: async (id) => session(id),
      getKnownDirectories: () => ["/workspace", "/broken"],
      listPendingPermissions: async (directory) => {
        requestedDirectories.push(directory)
        if (directory === "/broken") {
          throw new Error("permission.list failed")
        }
        return []
      },
      getPermissionState: async () => "ok",
      reply: async () => undefined,
      wait: async () => undefined,
    })

    await expect(runtime.reconcilePending()).rejects.toThrow("permission.list failed")
    expect(requestedDirectories).toEqual(["/workspace", "/broken"])
  })

  test("treats an already resolved permission as handled without replying", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: false, sessions: { child: true } }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "resolved",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission({ ...permission, id: "resolved" })).toBe(true)
    expect(replyCalls).toBe(0)
  })

  test("applies the global default after a fully resolved lineage with no explicit overrides", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map([["child", session("child", "root")], ["root", session("root")]]),
      getSession: async (id: string) => session(id),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(true)
    expect(replyCalls).toBe(1)
  })

  test("fails closed against a true global default when lineage cannot be resolved", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map(),
      getSession: async () => { throw new Error("offline") },
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("fails closed under a true global default when a cached lineage node is null", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map([["child", null as unknown as Session]]),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("fails closed under a true global default when a cached lineage node is an empty object", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map([["child", {} as Session]]),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("fails closed under a true global default when a cached lineage node has a mismatched id", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map([["child", session("other")]]),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })

  test("fails closed under a true global default when a fetched lineage node has a mismatched id", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ default: true, sessions: {} }),
      getSessions: () => new Map(),
      getSession: async () => session("other"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => "ok",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission)).toBe(false)
    expect(replyCalls).toBe(0)
  })
})
