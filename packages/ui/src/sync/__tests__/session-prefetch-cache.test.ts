import { describe, expect, test } from "bun:test"

import { shouldSkipSessionPrefetch } from "../session-prefetch-cache"

describe("shouldSkipSessionPrefetch", () => {
  test("does not skip when only metadata exists without cached messages", () => {
    expect(shouldSkipSessionPrefetch({
      hasMessages: false,
      info: { limit: 200, complete: true, at: 1_000 },
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("does not skip a larger fetch when only a smaller partial prefetch is cached", () => {
    expect(shouldSkipSessionPrefetch({
      hasMessages: true,
      info: { limit: 50, complete: false, at: 1_000 },
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("still skips a recent partial prefetch when cached coverage matches the request", () => {
    expect(shouldSkipSessionPrefetch({
      hasMessages: true,
      info: { limit: 200, complete: false, at: 1_000 },
      pageSize: 200,
      now: 1_001,
    })).toBe(true)
  })
})
