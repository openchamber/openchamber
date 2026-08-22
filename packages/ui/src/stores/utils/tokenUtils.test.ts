import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { computeCacheHitRate, contextTokensFromBreakdown, extractTokensFromMessage, sumTokenBreakdown } from "./tokenUtils"

const assistantMessage = (tokens: unknown): { info: Message; parts: Part[] } => ({
  info: { tokens } as unknown as Message,
  parts: [],
})

describe("computeCacheHitRate", () => {
  test("returns zero and hasInput=false for null input", () => {
    const result = computeCacheHitRate(null)
    expect(result).toEqual({ percent: 0, hasInput: false })
  })

  test("returns zero and hasInput=false for undefined input", () => {
    const result = computeCacheHitRate(undefined)
    expect(result).toEqual({ percent: 0, hasInput: false })
  })

  test("returns zero and hasInput=false when input is zero", () => {
    const result = computeCacheHitRate({ input: 0, cache: { read: 0, write: 0 } })
    expect(result).toEqual({ percent: 0, hasInput: false })
  })

  test("returns zero and hasInput=false when input is negative", () => {
    const result = computeCacheHitRate({ input: -5, cache: { read: 0, write: 0 } })
    expect(result).toEqual({ percent: 0, hasInput: false })
  })

  test("returns zero percent when no cache read tokens", () => {
    const result = computeCacheHitRate({ input: 1000, cache: { read: 0, write: 200 } })
    expect(result).toEqual({ percent: 0, hasInput: true })
  })

  test("computes correct percentage: 31.25% with cache read + cache write", () => {
    // total = 1000 + 500 + 100 = 1600, hit = 500 / 1600 = 31.25%
    const result = computeCacheHitRate({ input: 1000, cache: { read: 500, write: 100 } })
    expect(Math.abs(result.percent - 31.25) < 1e-2).toBe(true)
    expect(result.hasInput).toBe(true)
  })

  test("computes correct percentage: 50% when cache read equals non-cached input (no cache write)", () => {
    // total = 1000 + 1000 + 0 = 2000, hit = 1000 / 2000 = 50%
    const result = computeCacheHitRate({ input: 1000, cache: { read: 1000, write: 0 } })
    expect(result.percent).toBe(50)
    expect(result.hasInput).toBe(true)
  })

  test("handles missing cache object", () => {
    const result = computeCacheHitRate({ input: 500 })
    expect(result).toEqual({ percent: 0, hasInput: true })
  })

  test("handles missing cache.read", () => {
    const result = computeCacheHitRate({ input: 500, cache: { write: 100 } })
    expect(result).toEqual({ percent: 0, hasInput: true })
  })

  test("computes below 100% when cache.read is larger than non-cached input", () => {
    // total = 200 + 100 = 300, hit = 200 / 300 = 66.7% — not clamped
    const result = computeCacheHitRate({ input: 100, cache: { read: 200, write: 0 } })
    expect(Math.abs(result.percent - 66.67) < 1e-2).toBe(true)
    expect(result.hasInput).toBe(true)
  })

  test("clamps to 0% when cache.read is negative (defensive against bad data)", () => {
    const result = computeCacheHitRate({ input: 100, cache: { read: -50, write: 0 } })
    expect(result.percent).toBe(0)
    expect(result.hasInput).toBe(true)
  })

  test("handles real-world Anthropic example: 850 cached + 100 write + 1000 non-cached", () => {
    // total = 1000 + 850 + 100 = 1950, hit = 850 / 1950 ≈ 43.6%
    const result = computeCacheHitRate({ input: 1000, cache: { read: 850, write: 100 } })
    expect(Math.abs(result.percent - 43.59) < 1e-1).toBe(true)
    expect(result.hasInput).toBe(true)
  })

  test("handles real-world Anthropic example: zero cache on first turn", () => {
    // First turn always has 0 cache — should show 0% with hasInput=true
    const result = computeCacheHitRate({ input: 2000, cache: { read: 0, write: 2000 } })
    expect(result.percent).toBe(0)
    expect(result.hasInput).toBe(true)
  })
})

describe("sumTokenBreakdown (regression)", () => {
  test("sums all fields", () => {
    const total = sumTokenBreakdown({
      input: 100,
      output: 50,
      reasoning: 20,
      cache: { read: 80, write: 20 },
    })
    expect(total).toBe(270)
  })

  test("handles null safely", () => {
    expect(sumTokenBreakdown(null)).toBe(0)
    expect(sumTokenBreakdown(undefined)).toBe(0)
  })
})

describe("contextTokensFromBreakdown", () => {
  test("prefers the server-reported total over the summed fields", () => {
    const breakdown = { total: 500, input: 100, output: 50, reasoning: 20, cache: { read: 800, write: 20 } }
    expect(contextTokensFromBreakdown(breakdown)).toBe(500)
  })

  test("real multi-step turn: summing overstates a 1M window 14x, the total matches it", () => {
    // Captured from opencode 1.18.18 (/session/:id/message) after a turn with
    // ~14 tool-call round-trips. Every round-trip re-reads the whole cached
    // prompt, so cache.read accumulates to 3.29M while the window really held
    // 232,872. Summing rendered the context meter at 330.6% of a 1M window.
    const breakdown = { total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } }
    expect(contextTokensFromBreakdown(breakdown)).toBe(232_872)
    expect(sumTokenBreakdown(breakdown)).toBe(3_306_479)
  })

  test("single-step turn: the total and the summed fields agree", () => {
    // Captured from the same server: one round-trip, nothing accumulates.
    const breakdown = { total: 117_714, input: 1_116, output: 87, reasoning: 543, cache: { read: 115_968, write: 0 } }
    expect(contextTokensFromBreakdown(breakdown)).toBe(sumTokenBreakdown(breakdown))
  })

  test("falls back to summing when the server sends no total (older servers)", () => {
    expect(contextTokensFromBreakdown({ input: 100, output: 50, reasoning: 20, cache: { read: 80, write: 20 } })).toBe(270)
  })

  test("falls back to summing when the total is zero or not a finite number", () => {
    expect(contextTokensFromBreakdown({ total: 0, input: 40 })).toBe(40)
    expect(contextTokensFromBreakdown({ total: Number.NaN, input: 40 })).toBe(40)
  })

  test("handles null and undefined", () => {
    expect(contextTokensFromBreakdown(null)).toBe(0)
    expect(contextTokensFromBreakdown(undefined)).toBe(0)
  })
})

describe("extractTokensFromMessage", () => {
  test("uses the reported total from the message info breakdown", () => {
    const message = assistantMessage({ total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } })
    expect(extractTokensFromMessage(message)).toBe(232_872)
  })

  test("sums the info breakdown when no total is reported", () => {
    expect(extractTokensFromMessage(assistantMessage({ input: 100, output: 50, reasoning: 20, cache: { read: 80, write: 20 } }))).toBe(270)
  })

  test("returns plain numeric tokens as-is", () => {
    expect(extractTokensFromMessage(assistantMessage(1234))).toBe(1234)
  })

  test("prefers the reported total when tokens live on a part", () => {
    const message: { info: Message; parts: Part[] } = {
      info: {} as Message,
      parts: [{ tokens: { total: 500, input: 2_000 } } as unknown as Part],
    }
    expect(extractTokensFromMessage(message)).toBe(500)
  })

  test("returns 0 when neither info nor parts carry tokens", () => {
    expect(extractTokensFromMessage({ info: {} as Message, parts: [] })).toBe(0)
  })
})
