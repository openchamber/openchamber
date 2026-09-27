import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import {
  displayedPermissionMode,
  nextPermissionMode,
  resolvePermissionMode,
  type PermissionModeMap,
} from "./permissionAutoAccept"

function makeSession(id: string, parentID?: string): Session {
  return { id, parentID } as Session
}

describe("resolvePermissionMode", () => {
  test("is ask when no mode is set", () => {
    expect(resolvePermissionMode({
      modes: {},
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe("ask")
  })

  test("returns the session's own mode", () => {
    const modes: PermissionModeMap = { s1: "safety" }
    expect(resolvePermissionMode({
      modes,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe("safety")
  })

  test("inherits from the nearest ancestor", () => {
    const modes: PermissionModeMap = { grandparent: "auto" }
    const sessions = [
      makeSession("grandparent"),
      makeSession("parent", "grandparent"),
      makeSession("child", "parent"),
    ]
    expect(resolvePermissionMode({
      modes,
      sessions,
      sessionID: "child",
    })).toBe("auto")
  })

  test("uses a prebuilt session index for lineage lookup", () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    expect(resolvePermissionMode({
      modes: { parent: "auto" },
      sessions: [],
      sessionById: new Map([[parent.id, parent], [child.id, child]]),
      sessionID: "child",
    })).toBe("auto")
  })

  test("ignores a sibling's mode", () => {
    const modes: PermissionModeMap = { sibling: "auto" }
    const sessions = [
      makeSession("parent"),
      makeSession("sibling", "parent"),
      makeSession("child", "parent"),
    ]
    expect(resolvePermissionMode({
      modes,
      sessions,
      sessionID: "child",
    })).toBe("ask")
  })

  test("a child's own mode overrides its parent", () => {
    const modes: PermissionModeMap = { parent: "auto", child: "ask" }
    const sessions = [
      makeSession("parent"),
      makeSession("child", "parent"),
    ]
    expect(resolvePermissionMode({
      modes,
      sessions,
      sessionID: "child",
    })).toBe("ask")
  })
})

describe("permission mode cycle", () => {
  test("goes ask, safety, auto while the safety net is available", () => {
    expect(nextPermissionMode("ask", true)).toBe("safety")
    expect(nextPermissionMode("safety", true)).toBe("auto")
    expect(nextPermissionMode("auto", true)).toBe("ask")
  })

  test("skips safety, and shows a safety session as ask, while it is unavailable", () => {
    expect(displayedPermissionMode("safety", false)).toBe("ask")
    expect(nextPermissionMode("safety", false)).toBe("auto")
    expect(nextPermissionMode("ask", false)).toBe("auto")
    expect(nextPermissionMode("auto", false)).toBe("ask")
  })
})
