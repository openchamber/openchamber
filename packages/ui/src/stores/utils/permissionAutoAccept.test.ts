import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./permissionAutoAccept"

function makeSession(id: string, parentID?: string): Session {
  return { id, parentID } as Session
}

describe("autoRespondsPermission", () => {
  test("returns false when autoAccept is empty", () => {
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept: {},
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(false)
  })

  test("returns true when session has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: true }
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(true)
  })

  test("returns false when session has autoAccept disabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: false }
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(false)
  })

  test("returns true when parent has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { parent: true }
    const sessions = [
      makeSession("parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(true)
  })

  test("returns true when grandparent has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { grandparent: true }
    const sessions = [
      makeSession("grandparent"),
      makeSession("parent", "grandparent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(true)
  })

  test("uses a prebuilt session index for lineage lookup", () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept: { parent: true },
      sessions: [],
      sessionById: new Map([[parent.id, parent], [child.id, child]]),
      sessionID: "child",
    })).toBe(true)
  })

  test("returns false when only sibling has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { sibling: true }
    const sessions = [
      makeSession("parent"),
      makeSession("sibling", "parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(false)
  })

  test("child autoAccept overrides parent", () => {
    const autoAccept: PermissionAutoAcceptMap = { parent: true, child: false }
    const sessions = [
      makeSession("parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(false)
  })

  test("falls back to the global default after a fully resolved lineage with no explicit policy", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: {},
      sessions: [makeSession("root"), makeSession("child", "root")],
      sessionID: "child",
    })).toBe(true)
  })

  test("explicit child disable overrides a true global default", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: { child: false },
      sessions: [makeSession("root"), makeSession("child", "root")],
      sessionID: "child",
    })).toBe(false)
  })

  test("explicit child enable overrides a false global default", () => {
    expect(autoRespondsPermission({
      defaultEnabled: false,
      autoAccept: { child: true },
      sessions: [makeSession("root"), makeSession("child", "root")],
      sessionID: "child",
    })).toBe(true)
  })

  test("returns false for an unknown session even when the global default is enabled", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: {},
      sessions: [],
      sessionID: "unknown",
    })).toBe(false)
  })

  test("fails closed under a true global default when a cached lineage node is null", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: {},
      sessions: [],
      sessionById: new Map([["child", null as unknown as Session]]),
      sessionID: "child",
    })).toBe(false)
  })

  test("fails closed under a true global default when a cached lineage node is an empty object", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: {},
      sessions: [],
      sessionById: new Map([["child", {} as Session]]),
      sessionID: "child",
    })).toBe(false)
  })

  test("fails closed under a true global default when a cached lineage node has a mismatched id", () => {
    expect(autoRespondsPermission({
      defaultEnabled: true,
      autoAccept: {},
      sessions: [],
      sessionById: new Map([["child", makeSession("other", "root")]]),
      sessionID: "child",
    })).toBe(false)
  })
})
