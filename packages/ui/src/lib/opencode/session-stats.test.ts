import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "./client"
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../runtime-url"
import { fetchUsageStats } from "./session-stats"

const previous = getRuntimeUrlResolver()
beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: "https://stats.test" })
  opencodeClient.reconnectToRuntimeBaseUrl()
})
afterEach(() => {
  setRuntimeUrlResolver(previous)
  opencodeClient.reconnectToRuntimeBaseUrl()
})

const tokens = (input: number) => ({ input, output: 2, reasoning: 1, cache: { read: 3, write: 4 } })

const wire = {
  range: { from: 1_000, to: 2_000 },
  sessions: 2,
  subagents: 1,
  prompts: 5,
  steps: 9,
  tokens: tokens(10),
  cost: 1.25,
  tools: {
    mode: "detail",
    totals: { calls: 9, succeeded: 7, failed: 1, unfinished: 1 },
    usage: [
      { name: "read", calls: 5, succeeded: 4, failed: 1, unfinished: 0, durationP50: 340 },
      { name: "bash", calls: 4, succeeded: 3, failed: 0, unfinished: 1 },
    ],
  },
  activeDays: 2,
  streak: 2,
  activity: [{ date: "2026-09-01", steps: 4 }],
  models: [{ model: { providerID: "anthropic", id: "claude", variant: "high" }, steps: 9, tokens: tokens(10), cost: 1.25 }],
}

describe("session.stats boundary", () => {
  test("sends the range, project, zone and the tool breakdown, and projects the report", async () => {
    let url: URL | null = null
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      url = new URL(input instanceof Request ? input.url : input.toString())
      return Response.json({ data: wire })
    })
    try {
      const stats = await fetchUsageStats({ from: 1_000, projectID: "prj_1", timezone: "Europe/Kyiv" })
      expect(url!.pathname).toBe("/api/experimental/session/stats")
      expect(Object.fromEntries(url!.searchParams)).toEqual({
        from: "1000",
        project: "prj_1",
        timezone: "Europe/Kyiv",
        tools: "detail",
      })
      expect(stats.tokens).toEqual({ input: 10, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 4, total: 20 })
      expect(stats.tools).toEqual({
        mode: "detail",
        totals: { calls: 9, succeeded: 7, failed: 1, unfinished: 1 },
        usage: [
          { name: "read", calls: 5, succeeded: 4, failed: 1, unfinished: 0, durationP50: 340 },
          { name: "bash", calls: 4, succeeded: 3, failed: 0, unfinished: 1, durationP50: null },
        ],
      })
      expect(stats.models[0]).toMatchObject({ providerID: "anthropic", modelID: "claude", variant: "high", cost: 1.25 })
      expect(stats.range).toEqual({ from: 1_000, to: 2_000 })
    } finally {
      fetch.mockRestore()
    }
  })

  test("omits unset filters so OpenCode counts every project from the first message", async () => {
    let url: URL | null = null
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      url = new URL(input instanceof Request ? input.url : input.toString())
      return Response.json({ data: wire })
    })
    try {
      await fetchUsageStats({ timezone: "UTC" })
      expect([...url!.searchParams.keys()].sort()).toEqual(["timezone", "tools"])
    } finally {
      fetch.mockRestore()
    }
  })

  test("a failed read throws instead of returning an empty report", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ _tag: "InvalidRequestError", message: "Stats range must end after it starts" }, { status: 400 }),
    )
    try {
      const error = await fetchUsageStats({ from: 5, to: 1, timezone: "UTC" }).then(
        () => null,
        (reason: Error) => reason,
      )
      expect(error).toMatchObject({ operation: "session.stats" })
    } finally {
      fetch.mockRestore()
    }
  })
})
