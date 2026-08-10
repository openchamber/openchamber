import { describe, expect, test } from "bun:test"
import { OPENCHAMBER_AGENT_TOOL_NAME, resolveAgentToolGate } from "./agent-tool-gate"

describe("resolveAgentToolGate", () => {
  test("disables the control tool for models that cannot tool-call", () => {
    // The bug this fixes: Vertex Gemini image models reject any request that
    // carries a function declaration, so the injected tool must be withheld.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: false })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: false,
    })
  })

  test("enables the control tool for models that can tool-call", () => {
    expect(resolveAgentToolGate({ modelSupportsToolCalls: true })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: true,
    })
  })

  test("treats unknown capability as capable", () => {
    // Metadata may not be loaded yet. Defaulting to disabled would silently
    // strip the tool from models that support it.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: undefined })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: true,
    })
  })

})
