/**
 * Per-send tool enablement for models that cannot call tools.
 *
 * OpenCode declares every registered tool to the provider regardless of the
 * selected model: `capabilities.toolcall` is populated from config but never
 * read in the request path. Providers that reject function calling outright then
 * fail every send — Vertex Gemini image models return `Unable to submit request
 * because the model does not support function calling`. The rejection is
 * triggered by the presence of *any* `functionDeclarations`, so suppressing one
 * tool is not enough; the whole set has to go.
 *
 * Agent `permission` config cannot cover this either, because the stock agents
 * begin with `"*": "allow"` and OpenChamber additionally injects its own
 * `openchamber` tool that no stock agent names.
 *
 * Rationale, upstream mechanics, and runtime parity live in
 * `packages/web/server/lib/agent-tool/DOCUMENTATION.md` ("Per-send model
 * gating").
 */

/** Matches every tool, including OpenChamber's injected `openchamber` control tool. */
const ALL_TOOLS = "*"

type AgentToolGateInput = {
  /**
   * `capabilities.toolcall` for the selected model, as surfaced by
   * `useConfigStore.getModelMetadata`. `undefined` means "unknown", which must
   * be treated as capable: assuming otherwise would silently strip tools from
   * every model whose metadata has not loaded yet.
   */
  modelSupportsToolCalls: boolean | undefined
}

/**
 * Compute the `tools` map for one send. Always complete, never a partial patch:
 * OpenCode replaces the session's permission ruleset with this map, so omitting
 * the key would strand tools disabled for the rest of the session.
 *
 * `{"*": false}` drops the `tools` field from the provider request entirely;
 * `{"*": true}` restores every tool, which is what lets a session recover after
 * the user switches back to a tool-calling model.
 */
export const resolveAgentToolGate = (input: AgentToolGateInput): Record<string, boolean> => {
  const enabled = input.modelSupportsToolCalls !== false
  return { [ALL_TOOLS]: enabled }
}
