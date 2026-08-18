import { describe, expect, mock, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createVSCodePermissionAutoAcceptRuntime } from "./vscode-permission-auto-accept"

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
      getPolicy: () => ({ root: true }),
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
      getPolicy: () => ({ root: true, child: false }),
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
      getPolicy: () => ({ root: true }),
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
      getPolicy: () => ({ child: true }),
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

  test("routes the state check and reply through the permission event directory", async () => {
    const stateDirectories: Array<string | undefined> = []
    const replyDirectories: Array<string | undefined> = []
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async (_sessionId, _requestId, directory) => {
        stateDirectories.push(directory)
        return "ok"
      },
      reply: async (_sessionId, _requestId, directory) => { replyDirectories.push(directory) },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(permission, "/permission/project")).toBe(true)
    expect(stateDirectories).toEqual(["/permission/project"])
    expect(replyDirectories).toEqual(["/permission/project"])
  })

  test("reconciles existing pending permissions immediately after enablement", async () => {
    const replied: string[] = []
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ root: true, disabled: false }),
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

  test("accepts visible pending permissions before a network reconciliation failure", async () => {
    const replied: string[] = []
    let stateChecks = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      getKnownPendingPermissions: () => [permission],
      listPendingPermissions: async () => { throw new Error("offline") },
      getPermissionState: async () => {
        stateChecks += 1
        return "ok"
      },
      reply: async (_sessionId, requestId) => { replied.push(requestId) },
      wait: async () => undefined,
    })

    await expect(runtime.reconcilePending("/repo")).rejects.toThrow("offline")
    expect(stateChecks).toBe(0)
    expect(replied).toEqual(["perm-1"])
  })

  test("deduplicates visible and network pending permissions", async () => {
    let replyCalls = 0
    let stateChecks = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      getKnownPendingPermissions: () => [permission],
      listPendingPermissions: async () => [permission],
      getPermissionState: async () => {
        stateChecks += 1
        return "ok"
      },
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    await runtime.reconcilePending("/repo")
    expect(stateChecks).toBe(0)
    expect(replyCalls).toBe(1)
  })

  test("sends a live-event reply immediately without a permission-state preflight", async () => {
    let stateChecks = 0
    let replyStarted = false
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [],
      getPermissionState: async () => {
        stateChecks += 1
        return "ok"
      },
      reply: async () => { replyStarted = true },
      wait: async () => undefined,
    })

    expect(await runtime.processPermission(
      { ...permission, id: "immediate" },
      "/repo",
      { verifyPending: false },
    )).toBe(true)
    expect(stateChecks).toBe(0)
    expect(replyStarted).toBe(true)
  })

  test("keeps the permission-state preflight for refresh reconciliation", async () => {
    let replyCalls = 0
    const runtime = createVSCodePermissionAutoAcceptRuntime({
      getPolicy: () => ({ child: true }),
      getSessions: () => new Map(),
      getSession: async () => session("child"),
      listPendingPermissions: async () => [{ ...permission, id: "resolved" }],
      getPermissionState: async () => "resolved",
      reply: async () => { replyCalls += 1 },
      wait: async () => undefined,
    })

    await runtime.reconcilePending("/repo")
    expect(replyCalls).toBe(0)
  })
})
