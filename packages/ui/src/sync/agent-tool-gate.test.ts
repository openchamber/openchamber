import { describe, expect, test } from "bun:test"
import { OPENCHAMBER_AGENT_TOOL_NAME, resolveAgentToolGate } from './agent-tool-gate'

describe('resolveAgentToolGate', () => {
  test('disables the control tool for models that cannot tool-call', () => {
    // The bug this fixes: Vertex Gemini image models reject any request that
    // carries a function declaration, so the injected tool must be withheld.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: false, agentControlToolEnabled: true })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: false,
    })
  })

  test('enables the control tool for models that can tool-call', () => {
    expect(resolveAgentToolGate({ modelSupportsToolCalls: true, agentControlToolEnabled: true })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: true,
    })
  })

  test('treats unknown capability as capable', () => {
    // Metadata may not be loaded yet. Defaulting to disabled would silently
    // strip the tool from models that support it.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: undefined, agentControlToolEnabled: true })).toEqual({
      [OPENCHAMBER_AGENT_TOOL_NAME]: true,
    })
  })

  test('sends no tools field when the control tool was never injected', () => {
    // OpenCode replaces the session permission ruleset whenever a send carries
    // `tools`. With the tool disabled in Settings there is nothing to gate, so
    // the session's permissions must be left alone.
    expect(resolveAgentToolGate({ modelSupportsToolCalls: false, agentControlToolEnabled: false })).toBe(undefined)
    expect(resolveAgentToolGate({ modelSupportsToolCalls: true, agentControlToolEnabled: false })).toBe(undefined)
  })

  test('always returns the complete map so session permissions self-correct', () => {
    // OpenCode persists this map as the session ruleset. Returning a partial
    // patch would strand the tool disabled after switching back to a
    // tool-calling model, so both states must name the tool explicitly.
    const denied = resolveAgentToolGate({ modelSupportsToolCalls: false, agentControlToolEnabled: true })
    const allowed = resolveAgentToolGate({ modelSupportsToolCalls: true, agentControlToolEnabled: true })

    expect(Object.keys(denied ?? {})).toEqual([OPENCHAMBER_AGENT_TOOL_NAME])
    expect(Object.keys(allowed ?? {})).toEqual([OPENCHAMBER_AGENT_TOOL_NAME])
  })
})
