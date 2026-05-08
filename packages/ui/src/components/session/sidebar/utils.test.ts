import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { compareSessionsByPinnedAndTime } from "./utils"

const makeSession = (id: string, created: number, updated: number): Session => ({
  id,
  title: id,
  parentID: null,
  share: null,
  version: "",
  time: { created, updated, archived: 0 },
}) as unknown as Session

describe("compareSessionsByPinnedAndTime", () => {
  test("keeps pinned sessions first", () => {
    const pinned = new Set(["b"])
    const byUser = new Map<string, number>([["a", 500], ["b", 100]])
    const sessions = [makeSession("a", 100, 900), makeSession("b", 50, 1000)]

    const sorted = [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinned, byUser))
    expect(sorted.map((session) => session.id)).toEqual(["b", "a"])
  })

  test("sorts unpinned by last user activity, not session updated", () => {
    const pinned = new Set<string>()
    const byUser = new Map<string, number>([["a", 300], ["b", 200]])
    const sessions = [makeSession("a", 100, 1), makeSession("b", 100, 99999)]

    const sorted = [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinned, byUser))
    expect(sorted.map((session) => session.id)).toEqual(["a", "b"])
  })

  test("falls back to creation time when user activity is unknown", () => {
    const pinned = new Set<string>()
    const sessions = [makeSession("a", 100, 99999), makeSession("b", 200, 1)]

    const sorted = [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinned, new Map()))
    expect(sorted.map((session) => session.id)).toEqual(["b", "a"])
  })
})
