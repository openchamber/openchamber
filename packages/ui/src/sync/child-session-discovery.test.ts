import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { childSessionsInDirectory, newlyDiscoveredChildParents, selectNewChildSessions } from "./child-session-discovery"

const session = (id: string, parentID?: string): Session => {
  return {
    id, parentID, projectID: "project", directory: "/repo", title: id, cost: 0,
    time: { created: 1, updated: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("selectNewChildSessions", () => {
  test("refreshes a parent when a discovered child's directory or relationship changes", () => {
    const child = session("child", "root")
    const known = new Map([[child.id, child]])
    expect([...newlyDiscoveredChildParents([{ ...child, directory: "/moved" }], known)]).toEqual(["root"])
    expect([...newlyDiscoveredChildParents([{ ...child, parentID: "other" }], known)]).toEqual(["other"])
  })
  test("materializes a remote relationship once while allowing missing local population", () => {
    const child = { ...session("remote", "root"), directory: "/other" }
    expect([...newlyDiscoveredChildParents([child], new Map())]).toEqual(["root"])
    const known = new Map([[child.id, child]])
    expect([...newlyDiscoveredChildParents([child], known)]).toEqual([])
    expect(childSessionsInDirectory([child], "/other").map((entry) => entry.id)).toEqual(["remote"])
  })
  test("keeps cross-directory discovery global without inserting it into the parent's store", () => {
    const listed = [session("local", "root"), { ...session("remote", "root"), directory: "/other" }]
    const discovered = selectNewChildSessions(listed, new Set(), new Set(["root"]), () => false)
    expect(discovered.map((entry) => entry.id)).toEqual(["local", "remote"])
    expect(childSessionsInDirectory(discovered, "/repo").map((entry) => entry.id)).toEqual(["local"])
    expect(childSessionsInDirectory(discovered, "/other").map((entry) => entry.id)).toEqual(["remote"])
  })
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
