import { describe, expect, test } from "bun:test"
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
