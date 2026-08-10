/**
 * Per-send enablement for OpenChamber's injected `openchamber` control tool.
 *
 * The tool is injected into every managed OpenCode process before any model is
 * known, so models that cannot call tools would otherwise have it declared to
 * their provider — which Vertex Gemini image models reject outright. Agent
 * `permission` config cannot cover it, because no stock agent denies a tool it
 * does not know exists.
 *
 * Rationale, upstream mechanics, and runtime parity live in
 * `packages/web/server/lib/agent-tool/DOCUMENTATION.md` ("Per-send model
 * gating") — that module owns the injection this gate compensates for.
 */

/** OpenCode tool ID injected by `packages/web/server/lib/agent-tool/runtime.js`. */
export const OPENCHAMBER_AGENT_TOOL_NAME = "openchamber"

type AgentToolGateInput = {
  /**
   * `capabilities.toolcall` for the selected model, as surfaced by
   * `useConfigStore.getModelMetadata`. `undefined` means "unknown", which must
   * be treated as capable: assuming otherwise would silently disable the tool
   * for every model whose metadata has not loaded yet.
   */
  modelSupportsToolCalls: boolean | undefined
}

/**
 * Compute the `tools` map for one send. Always complete, never a partial patch:
 * OpenCode replaces the session's permission ruleset with this map, so omitting
 * a key would strand the tool disabled for the rest of the session.
 *
 * Sent unconditionally, without consulting `agentControlToolEnabled`. That
 * setting only applies on the next managed OpenCode restart, so between toggling
 * it off and restarting the tool is still injected, and skipping the gate would
 * let the provider rejection back in. Naming an uninjected tool is inert.
 */
export const resolveAgentToolGate = (input: AgentToolGateInput): Record<string, boolean> => {
  const enabled = input.modelSupportsToolCalls !== false
  return { [OPENCHAMBER_AGENT_TOOL_NAME]: enabled }
}
