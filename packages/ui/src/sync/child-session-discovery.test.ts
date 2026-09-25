import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { selectNewChildSessions } from "./child-session-discovery"

const session = (id: string, parentID?: string): Session => {
  return {
    id, parentID, projectID: "project", directory: "/repo", title: id, cost: 0,
    time: { created: 1, updated: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
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
