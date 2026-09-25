import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"

import { shouldSkipStaleSessionEvent } from "../session-event-freshness"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  projectID: "proj_1",
  directory: "/repo",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time,
})

describe("shouldSkipStaleSessionEvent", () => {
  test("skips a stale SSE session update after a newer local rename", () => {
    const current = buildSession("New Title", { created: 1, updated: 20 })
    const incoming = buildSession("Old Title", { created: 1, updated: 10 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })

  test("allows a fresher SSE update to apply", () => {
    const current = buildSession("Old Title", { created: 1, updated: 10 })
    const incoming = buildSession("New Title", { created: 1, updated: 20 })

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(false)
  })

  test("falls back to created timestamp when a record omits updated", () => {
    // SAFETY: `time.updated` is required on the domain type, but the guard
    // exists for wire records that arrive without it, which is what these two
    // literals stand in for.
    const withoutUpdated = (title: string, created: number): Session =>
      ({ ...buildSession(title, { created, updated: created }), time: { created } as Session["time"] })
    const current = withoutUpdated("Current", 20)
    const incoming = withoutUpdated("Incoming", 10)

    expect(shouldSkipStaleSessionEvent(current, incoming)).toBe(true)
  })
})
