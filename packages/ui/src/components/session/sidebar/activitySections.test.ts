import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { ACTIVE_NOW_MAX_AGE_MS, getSessionCreatedAtMs, pruneActiveNowEntries } from "./activitySections"

const session = (id: string, created: number, archived = 0, parentID: string | null = null): Session => ({
  id,
  title: id,
  parentID,
  share: null,
  version: "",
  time: { created, updated: created, archived },
}) as unknown as Session

describe("activitySections", () => {
  test("keeps unresolved active-now entries until activity hydration resolves", () => {
    const oldSession = session("old", 100)
    const pruned = pruneActiveNowEntries(
      [{ sessionId: "old" }],
      new Map([["old", oldSession]]),
      new Map(),
      new Set(),
      ACTIVE_NOW_MAX_AGE_MS + 1_000,
    )

    expect(pruned).toEqual([{ sessionId: "old" }])
  })

  test("prunes resolved active-now entries by last user activity", () => {
    const oldSession = session("old", 100)
    const pruned = pruneActiveNowEntries(
      [{ sessionId: "old" }],
      new Map([["old", oldSession]]),
      new Map([["old", 100]]),
      new Set(["old"]),
      ACTIVE_NOW_MAX_AGE_MS + 1_000,
    )

    expect(pruned).toEqual([])
  })

  test("keeps root active-now entries while descendant activity is unresolved", () => {
    const root = session("root", 100)
    const child = session("child", 200, 0, "root")
    const pruned = pruneActiveNowEntries(
      [{ sessionId: "root" }],
      new Map([["root", root], ["child", child]]),
      new Map(),
      new Set(["root"]),
      ACTIVE_NOW_MAX_AGE_MS + 1_000,
    )

    expect(pruned).toEqual([{ sessionId: "root" }])
  })

  test("exports created-at timestamp with accurate naming", () => {
    expect(getSessionCreatedAtMs(session("created", 123))).toBe(123)
  })
})
