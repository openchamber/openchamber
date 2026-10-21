import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "./model"
import { findCatalogModel, hasRunningToolInTurn } from "./model"

// OpenCode derives a Fast entry from the base model: its own catalog `id`,
// the base model's provider API `modelID`.
const luna = { id: "gpt-6-luna", modelID: "gpt-6-luna" }
const lunaFast = { id: "gpt-6-luna-fast", modelID: "gpt-6-luna" }

describe("findCatalogModel", () => {
  test("finds a derived entry by its catalog id", () => {
    expect(findCatalogModel([luna, lunaFast], "gpt-6-luna-fast")).toBe(lunaFast)
  })

  test("prefers the exact id over a shared provider API name", () => {
    expect(findCatalogModel([lunaFast, luna], "gpt-6-luna")).toBe(luna)
  })

  test("falls back to the provider API name when no id matches", () => {
    const aliased = { id: "my-alias", modelID: "vendor-model-v3" }
    expect(findCatalogModel([aliased], "vendor-model-v3")).toBe(aliased)
  })

  test("returns undefined for a missing list or id", () => {
    expect(findCatalogModel(undefined, "gpt-6-luna")).toBeUndefined()
    expect(findCatalogModel([luna], "")).toBeUndefined()
  })
})


const user = (id: string): UserMessage => ({ id, sessionID: "s", role: "user", time: { created: 1 } })
const assistant = (id: string): AssistantMessage => ({
  id, sessionID: "s", role: "assistant", time: { created: 2, completed: 3 },
  agent: "build", providerID: "p", modelID: "m", finish: "tool-calls",
})
const tool = (messageID: string, status: "running" | "completed"): Part => ({
  id: `tool-${messageID}`, callID: `tool-${messageID}`, type: "tool", tool: "shell",
  sessionID: "s", messageID,
  state: status === "running"
    ? { status: "running", input: { command: "npm test" }, time: { start: 1 } }
    : { status: "completed", input: { command: "npm test" }, output: "", metadata: {}, time: { start: 1, end: 2 } },
})

describe("hasRunningToolInTurn", () => {
  test("keeps a completed step working while its tool still runs", () => {
    expect(hasRunningToolInTurn([user("u"), assistant("a")], (id) => (id === "a" ? [tool("a", "running")] : []))).toBe(true)
  })

  test("finished tools do not keep the session working", () => {
    expect(hasRunningToolInTurn([user("u"), assistant("a")], (id) => (id === "a" ? [tool("a", "completed")] : []))).toBe(false)
  })

  test("ignores a running tool from an earlier prompt", () => {
    expect(hasRunningToolInTurn([user("u1"), assistant("a1"), user("u2"), assistant("a2")], (id) => (id === "a1" ? [tool("a1", "running")] : []))).toBe(false)
  })

  test("sees a running tool past a queued user prompt", () => {
    expect(hasRunningToolInTurn([user("u"), assistant("a"), user("u2")], (id) => (id === "a" ? [tool("a", "running")] : []))).toBe(true)
  })
})
