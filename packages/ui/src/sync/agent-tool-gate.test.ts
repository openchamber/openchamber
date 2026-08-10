import { describe, expect, test } from "bun:test"
import { resolveAgentToolGate } from "./agent-tool-gate"

describe("resolveAgentToolGate", () => {
  test("disables every tool for models that cannot tool-call", () => {
    // Vertex Gemini image models reject a request carrying ANY function
    // declaration, so suppressing one tool is not enough — the whole set must go.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: false })).toEqual({ "*": false })
  })

  test("enables every tool for models that can tool-call", () => {
    expect(resolveAgentToolGate({ modelSupportsToolCalls: true })).toEqual({ "*": true })
  })

  test("treats unknown capability as capable", () => {
    // Metadata may not be loaded yet. Defaulting to disabled would strip tools
    // from models that support them.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: undefined })).toEqual({ "*": true })
  })
})
