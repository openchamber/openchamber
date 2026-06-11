import { describe, expect, test } from "bun:test"
import { computeCacheHitRate, sumTokenBreakdown } from "./tokenUtils"

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
