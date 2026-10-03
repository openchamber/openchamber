import { describe, expect, test } from "bun:test"
import { readProjectConfigError } from "./configError"

const named = (name: string, data: Record<string, string | string[] | Array<{ message: string; path: string[] }>>) =>
  Object.assign(new Error("config"), { name, data })

describe("readProjectConfigError", () => {
  test("finds the error through a wrapping cause", () => {
    const wrapped = new Error("agent.list failed", {
      cause: named("ConfigInvalidError", { path: "/p/opencode.json", message: "bad file reference" }),
    })
    expect(readProjectConfigError(wrapped)).toEqual({
      name: "ConfigInvalidError",
      path: "/p/opencode.json",
      message: "bad file reference",
    })
  })

  test("joins schema issues one per line", () => {
    const error = named("ConfigInvalidError", {
      path: "/p/opencode.json",
      issues: [
        { message: "Expected string", path: ["mcp", "x", "url"] },
        { message: "Unknown key", path: [] },
      ],
    })
    expect(readProjectConfigError(error)?.message).toBe("mcp.x.url: Expected string\nUnknown key")
  })

  test("drops OpenCode's placeholder path", () => {
    expect(readProjectConfigError(named("ConfigJsonError", { path: "config", message: "Unexpected token" }))?.path).toBeUndefined()
  })

  test("ignores errors that are not about config", () => {
    expect(readProjectConfigError(new Error("transport failure"))).toBeNull()
    expect(readProjectConfigError(named("ProviderModelNotFoundError", { providerID: "a" }))).toBeNull()
    expect(readProjectConfigError(null)).toBeNull()
  })
})
