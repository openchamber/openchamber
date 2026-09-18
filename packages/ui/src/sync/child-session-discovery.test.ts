import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { selectNewChildSessions } from "./child-session-discovery"

const session = (id: string, parentID?: string): Session => {
  // SAFETY: discovery reads only id and parentID from listed sessions.
  return { id, parentID } as Session
}

describe("selectNewChildSessions", () => {
  test("adds children of watched parents that the store does not have yet", () => {
    const listed = [session("child", "root"), session("known", "root"), session("stranger", "other"), session("orphan")]

    const added = selectNewChildSessions(listed, new Set(["known"]), new Set(["root"]), () => false)

    expect(added.map((entry) => entry.id)).toEqual(["child"])
  })

  test("drops a child the global cache already knows as archived", () => {
    const listed = [session("stale", "root"), session("fresh", "root")]

    const added = selectNewChildSessions(listed, new Set(), new Set(["root"]), (id) => id === "stale")

    expect(added.map((entry) => entry.id)).toEqual(["fresh"])
  })
})
