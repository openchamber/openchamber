import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./permissionAutoAccept"

function makeSession(id: string, parentID?: string): Session {
  return { id, parentID } as Session
}

describe("autoRespondsPermission", () => {
  test("returns false when autoAccept is empty", () => {
    expect(autoRespondsPermission({
      autoAccept: {},
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(false)
  })

  test("returns true when session has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: true }
    expect(autoRespondsPermission({
      autoAccept,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(true)
  })

  test("returns false when session has autoAccept disabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: false }
    expect(autoRespondsPermission({
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
      autoAccept,
      sessions,
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
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(false)
  })

  test("returns false for unknown session", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: true }
    expect(autoRespondsPermission({
      autoAccept,
      sessions: [],
      sessionID: "unknown",
    })).toBe(false)
  })
})
