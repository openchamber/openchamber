/**
 * Per-send enablement for OpenChamber's injected `openchamber` control tool.
 *
 * OpenChamber injects that tool into every managed OpenCode process, before any
 * model is known. Providers that reject function calling outright — Vertex
 * Gemini image models ("Nano Banana") return
 * `Unable to submit request because the model does not support function calling`
 * — then fail every send, because a tool declaration reaches the provider even
 * when the selected model cannot use tools.
 *
 * Agent-level `tools`/`permission` config cannot cover this: OpenCode filters
 * tools by permission name, and no built-in agent denies `openchamber`, so the
 * injected tool survives every stock agent.
 *
 * OpenCode's per-send `tools` map is the supported lever, with one sharp edge:
 * it does not filter a single request, it *replaces* the session's permission
 * ruleset and persists it. A one-shot deny would therefore strand the tool off
 * for the rest of the session. So callers always send the complete desired map;
 * re-sending it makes the state self-correcting when the model changes.
 */

/** OpenCode tool ID injected by `packages/web/server/lib/agent-tool/runtime.js`. */
export const OPENCHAMBER_AGENT_TOOL_NAME = 'openchamber'

type AgentToolGateInput = {
  /**
   * `capabilities.toolcall` for the selected model, as surfaced by
   * `useConfigStore.getModelMetadata`. `undefined` means "unknown", which must
   * be treated as capable: assuming otherwise would silently disable the tool
   * for every model whose metadata has not loaded yet.
   */
  modelSupportsToolCalls: boolean | undefined
  /**
   * Whether OpenChamber injected the tool at all — the persisted
   * `agentControlToolEnabled` setting. When the tool was never injected there
   * is nothing to gate, and claiming a permission slot would be misleading.
   */
  agentControlToolEnabled: boolean
}

/**
 * Compute the `tools` map for one send, or `undefined` to send no `tools` field.
 *
 * Returning `undefined` matters: it leaves the session's permission ruleset
 * untouched for users who disabled the control tool, rather than overwriting it
 * with a rule about a tool that does not exist.
 */
export const resolveAgentToolGate = (
  input: AgentToolGateInput,
): Record<string, boolean> | undefined => {
  if (!input.agentControlToolEnabled) return undefined
  // Unknown capability is treated as capable — see `modelSupportsToolCalls`.
  const enabled = input.modelSupportsToolCalls !== false
  return { [OPENCHAMBER_AGENT_TOOL_NAME]: enabled }
}
