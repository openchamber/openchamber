import { describe, expect, test } from "bun:test"
import type { Message } from "@/lib/opencode/model"
import { getProtectedSessionCacheIds } from "./session-cache"

const assistant = (id: string, sessionID: string, completed?: number): Message => ({
  id,
  sessionID,
  role: "assistant",
  agent: "build",
  providerID: "anthropic",
  modelID: "claude-opus-4-1",
  time: completed === undefined ? { created: 1 } : { created: 1, completed },
})

const synthetic = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "synthetic",
  time: { created: 2 },
  text: "plugin prompt",
})

type Cache = Parameters<typeof getProtectedSessionCacheIds>[0]

const emptyCache = (): Cache => ({
  session_status: {},
  message: {},
  part: {},
  permission: {},
  form: {},
})

describe("getProtectedSessionCacheIds", () => {
  test("protects a session whose last conversation message is a running assistant turn", () => {
    const cache = emptyCache()
    cache.message.running = [assistant("m-1", "running")]
    cache.message.done = [assistant("m-2", "done", 5)]

    expect([...getProtectedSessionCacheIds(cache)]).toEqual(["running"])
  })

  test("keeps protecting a running turn when plumbing messages trail it", () => {
    const cache = emptyCache()
    cache.message.running = [assistant("m-1", "running"), synthetic("s-1", "running")]

    expect([...getProtectedSessionCacheIds(cache)]).toEqual(["running"])
  })

  test("does not protect a completed turn that plumbing messages trail", () => {
    const cache = emptyCache()
    cache.message.done = [assistant("m-1", "done", 5), synthetic("s-1", "done")]

    expect([...getProtectedSessionCacheIds(cache)]).toEqual([])
  })
})
