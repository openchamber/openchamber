import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { upsertSessionRecord } from "./session-records"

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id, slug: id, projectID: "project", directory: "/workspace", title: id, version: "1",
  time: { created: 1, updated: 1 }, ...overrides,
})

describe("upsertSessionRecord", () => {
  test("inserts missing IDs in binary order", () => {
    expect(upsertSessionRecord([session("a"), session("c")], session("b")).map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  test("preserves references for separately allocated equivalent metadata", () => {
    const current = [session("a", {
      metadata: { nested: ["value", { count: 1 }] },
      summary: { additions: 1, deletions: 2, files: 3, diffs: [{ file: "a", additions: 1, deletions: 0 }] },
    }), session("b")]
    const incoming = session("a", {
      metadata: { nested: ["value", { count: 1 }] },
      summary: { additions: 1, deletions: 2, files: 3, diffs: [{ file: "a", additions: 1, deletions: 0 }] },
    })
    const result = upsertSessionRecord(current, incoming)
    expect(result).toBe(current)
    expect(result[0]).toBe(current[0])
    expect(result[1]).toBe(current[1])
  })

  test("replaces a same-ID record when an unlisted semantic field changes", () => {
    const current = [session("a")]
    // SAFETY: The runtime SDK payload may contain an additive field before the local Session type is updated.
    const incoming = {
      ...session("a"),
      // SDK records can gain fields independently of this synchronization boundary.
      customField: "changed",
    } as Session

    expect(upsertSessionRecord(current, incoming)).not.toBe(current)
  })

  const changes: Array<[string, Partial<Session>, Partial<Session>]> = [
    ["scalars", { workspaceID: "one", path: "a", parentID: "p", cost: 1, agent: "a" }, { workspaceID: "two", path: "b", parentID: "q", cost: 2, agent: "b" }],
    ["tokens", { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }, { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 6 } } }],
    ["share and model", { share: { url: "a" }, model: { id: "m", providerID: "p", variant: "a" } }, { share: { url: "b" }, model: { id: "m", providerID: "p", variant: "b" } }],
    ["metadata", { metadata: { key: "a" } }, { metadata: { key: "b" } }],
    ["permission", { permission: [{ permission: "bash", pattern: "*", action: "ask" }] }, { permission: [{ permission: "bash", pattern: "*", action: "allow" }] }],
    ["revert", { revert: { messageID: "m", partID: "a", snapshot: "s", diff: "d" } }, { revert: { messageID: "m", partID: "b", snapshot: "s", diff: "d" } }],
    ["summary diffs", { summary: { additions: 1, deletions: 2, files: 3, diffs: [{ file: "a", additions: 1, deletions: 0 }] } }, { summary: { additions: 1, deletions: 2, files: 3, diffs: [{ file: "a", additions: 2, deletions: 0 }] } }],
    ["time", { time: { created: 1, updated: 1, compacting: 2, archived: 3 } }, { time: { created: 1, updated: 2, compacting: 2, archived: 3 } }],
  ]

  for (const [field, current, incoming] of changes) {
    test(`replaces only target when ${field} changes`, () => {
      const first = session("a")
      const target = session("b", current)
      const last = session("c")
      const list = [first, target, last]
      const result = upsertSessionRecord(list, session("b", incoming))
      expect(result).not.toBe(list)
      expect(result[0]).toBe(first)
      expect(result[1]).not.toBe(target)
      expect(result[2]).toBe(last)
    })
  }
})
