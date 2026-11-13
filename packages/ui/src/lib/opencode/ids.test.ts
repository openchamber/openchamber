import { describe, expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { ascendingId, descendingId } from "./ids"

const OPENCODE_ID = /^(msg|ses)_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const later = () => new Promise((resolve) => setTimeout(resolve, 2))

describe("client-minted ids", () => {
  test("message ids count up with time, as OpenCode mints them", async () => {
    const older = ascendingId("msg")
    await later()
    const newer = ascendingId("msg")
    expect(OPENCODE_ID.test(older)).toBe(true)
    expect(OPENCODE_ID.test(newer)).toBe(true)
    expect(older < newer).toBe(true)
  })

  test("session ids count down with time, as OpenCode mints them, so a new session lists first", async () => {
    const older = descendingId("ses")
    await later()
    const newer = descendingId("ses")
    expect(OPENCODE_ID.test(older)).toBe(true)
    expect(OPENCODE_ID.test(newer)).toBe(true)
    expect(newer < older).toBe(true)
    // Within one millisecond the counter keeps the order too.
    const first = descendingId("ses")
    const second = descendingId("ses")
    expect(second <= first).toBe(true)
  })
})

test("places a local session ID between earlier and later official session IDs", () => {
  // Given distinct timestamps shared by both ID generators.
  const now = Date.now
  let timestamp = 1_700_000_000_000
  Date.now = () => timestamp
  try {
    const before = Session.ID.create()
    timestamp += 1
    const local = descendingId("ses")
    timestamp += 1
    const after = Session.ID.create()
    // When a session list sorts by its official descending identity.
    const sorted = [before, local, after].sort()
    // Then local and server-created records share the same ordering.
    expect(sorted).toEqual([after, local, before])
  } finally {
    Date.now = now
  }
})
