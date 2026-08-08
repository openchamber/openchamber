import { describe, expect, test } from "bun:test"
import {
  computeCacheHitRate,
  computeSessionCostAndCounts,
  computeSessionTokenRate,
  extractTokensFromMessage,
  sumTokenBreakdown,
} from "./tokenUtils"
import type { Message, Part } from "@opencode-ai/sdk/v2"

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

describe("extractTokensFromMessage", () => {
  test("returns numeric tokens from info.tokens", () => {
    const msg = { info: { tokens: 500 } as unknown as Message, parts: [] as Part[] }
    expect(extractTokensFromMessage(msg)).toBe(500)
  })

  test("sums breakdown tokens from info.tokens", () => {
    const msg = {
      info: { tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 80, write: 20 } } } as unknown as Message,
      parts: [] as Part[],
    }
    expect(extractTokensFromMessage(msg)).toBe(270)
  })

  test("returns numeric tokens from a part when info.tokens is absent", () => {
    const msg = {
      info: {} as unknown as Message,
      parts: [{ type: "text", text: "hi" } as unknown as Part, { type: "token", tokens: 42 } as unknown as Part],
    }
    expect(extractTokensFromMessage(msg)).toBe(42)
  })

  test("sums breakdown tokens from a part when info.tokens is absent", () => {
    const msg = {
      info: {} as unknown as Message,
      parts: [{ type: "token", tokens: { input: 10, output: 5 } } as unknown as Part],
    }
    expect(extractTokensFromMessage(msg)).toBe(15)
  })

  test("returns 0 when no tokens are present anywhere", () => {
    const msg = { info: {} as unknown as Message, parts: [] as Part[] }
    expect(extractTokensFromMessage(msg)).toBe(0)
  })
})

describe("computeSessionCostAndCounts", () => {
  test("counts user and assistant messages and sums cost", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", cost: 0.5 },
      { role: "user" },
      { role: "assistant", cost: 0.3 },
    ] as unknown as Message[]
    const result = computeSessionCostAndCounts(messages)
    expect(result).toEqual({ totalCost: 0.8, userCount: 2, assistantCount: 2 })
  })

  test("ignores cost from non-assistant roles", () => {
    const messages = [{ role: "user", cost: 1.0 }] as unknown as Message[]
    expect(computeSessionCostAndCounts(messages).totalCost).toBe(0)
  })

  test("skips invalid cost values", () => {
    const messages = [
      { role: "assistant", cost: NaN },
      { role: "assistant", cost: -1 },
      { role: "assistant", cost: Infinity },
      { role: "assistant", cost: 0.2 },
    ] as unknown as Message[]
    expect(computeSessionCostAndCounts(messages).totalCost).toBe(0.2)
  })

  test("handles empty array", () => {
    expect(computeSessionCostAndCounts([])).toEqual({ totalCost: 0, userCount: 0, assistantCount: 0 })
  })

  test("matches deriveMessageRole: clientRole='user' counts as user even when role='assistant'", () => {
    const messages = [{ role: "assistant", clientRole: "user" }] as unknown as Message[]
    const result = computeSessionCostAndCounts(messages)
    expect(result.userCount).toBe(1)
    expect(result.assistantCount).toBe(0)
  })

  test("matches deriveMessageRole: userMessageMarker=true counts as user", () => {
    const messages = [{ role: "assistant", userMessageMarker: true, cost: 0.5 }] as unknown as Message[]
    const result = computeSessionCostAndCounts(messages)
    expect(result.userCount).toBe(1)
    expect(result.assistantCount).toBe(0)
    expect(result.totalCost).toBe(0)
  })

  test("matches deriveMessageRole: clientRole='assistant' counts as assistant even when role='system'", () => {
    const messages = [{ role: "system", clientRole: "assistant", cost: 0.1 }] as unknown as Message[]
    const result = computeSessionCostAndCounts(messages)
    expect(result.assistantCount).toBe(1)
    expect(result.userCount).toBe(0)
    expect(result.totalCost).toBe(0.1)
  })

  test("defaults to assistant when no role fields are present", () => {
    const messages = [{}] as unknown as Message[]
    const result = computeSessionCostAndCounts(messages)
    expect(result.assistantCount).toBe(1)
    expect(result.userCount).toBe(0)
  })
})

describe("computeSessionTokenRate", () => {
  test("returns zeros for empty array", () => {
    expect(computeSessionTokenRate([])).toEqual({ avgTokensPerSecond: 0, lastTokensPerSecond: 0 })
  })

  test("returns zeros when no assistant messages have valid time/tokens", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", time: { created: 1000, completed: 2000 } },
      { role: "assistant", tokens: { output: 100 } },
    ] as unknown as Message[]
    expect(computeSessionTokenRate(messages)).toEqual({ avgTokensPerSecond: 0, lastTokensPerSecond: 0 })
  })

  test("computes rate for a single assistant message", () => {
    const messages = [
      { role: "assistant", time: { created: 0, completed: 1000 }, tokens: { output: 100, reasoning: 50 } },
    ] as unknown as Message[]
    const result = computeSessionTokenRate(messages)
    expect(result.avgTokensPerSecond).toBe(150)
    expect(result.lastTokensPerSecond).toBe(150)
  })

  test("computes weighted average across multiple assistant messages", () => {
    const messages = [
      { role: "assistant", time: { created: 0, completed: 1000 }, tokens: { output: 100 } },
      { role: "assistant", time: { created: 0, completed: 2000 }, tokens: { output: 200 } },
    ] as unknown as Message[]
    const result = computeSessionTokenRate(messages)
    expect(result.avgTokensPerSecond).toBe(100)
    expect(result.lastTokensPerSecond).toBe(100)
  })

  test("subtracts non-overlapping tool durations from message duration", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 10000 }, tokens: { output: 1200 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "tool", state: { time: { start: 1000, end: 4000 } } },
      { type: "tool", state: { time: { start: 5000, end: 8000 } } },
    ]
    const result = computeSessionTokenRate(messages, getParts)
    expect(result.avgTokensPerSecond).toBe(300)
    expect(result.lastTokensPerSecond).toBe(300)
  })

  test("does not double-subtract overlapping tool durations", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 10000 }, tokens: { output: 500 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "tool", state: { time: { start: 1000, end: 5000 } } },
      { type: "tool", state: { time: { start: 2000, end: 6000 } } },
    ]
    const result = computeSessionTokenRate(messages, getParts)
    expect(result.avgTokensPerSecond).toBe(100)
    expect(result.lastTokensPerSecond).toBe(100)
  })

  test("handles nested tool intervals (inner fully within outer)", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 10000 }, tokens: { output: 500 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "tool", state: { time: { start: 1000, end: 6000 } } },
      { type: "tool", state: { time: { start: 2000, end: 5000 } } },
    ]
    const result = computeSessionTokenRate(messages, getParts)
    expect(result.avgTokensPerSecond).toBe(100)
    expect(result.lastTokensPerSecond).toBe(100)
  })

  test("skips tool parts with invalid time (end <= start)", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 5000 }, tokens: { output: 400 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "tool", state: { time: { start: 1000, end: 1000 } } },
      { type: "tool", state: { time: { start: 3000, end: 2000 } } },
    ]
    const result = computeSessionTokenRate(messages, getParts)
    expect(result.avgTokensPerSecond).toBe(80)
    expect(result.lastTokensPerSecond).toBe(80)
  })

  test("skips message when duration after tool subtraction is <= 0", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 5000 }, tokens: { output: 100 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "tool", state: { time: { start: 0, end: 5000 } } },
    ]
    expect(computeSessionTokenRate(messages, getParts)).toEqual({
      avgTokensPerSecond: 0,
      lastTokensPerSecond: 0,
    })
  })

  test("ignores non-tool parts when subtracting tool time", () => {
    const messages = [
      { role: "assistant", id: "m1", time: { created: 0, completed: 10000 }, tokens: { output: 800 } },
    ] as unknown as Message[]
    const getParts = () => [
      { type: "text", state: { time: { start: 1000, end: 5000 } } },
      { type: "tool", state: { time: { start: 1000, end: 3000 } } },
    ]
    const result = computeSessionTokenRate(messages, getParts)
    expect(result.avgTokensPerSecond).toBe(100)
    expect(result.lastTokensPerSecond).toBe(100)
  })
})
