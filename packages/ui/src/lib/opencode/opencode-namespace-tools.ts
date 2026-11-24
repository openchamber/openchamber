import { normalizeToolName, type ToolName } from "./tool-name"

/** Tools of OpenCode's `opencode` namespace, called directly or as `opencode_<name>`. */
const OPENCODE_NAMESPACE_TOOLS = new Set([
  "session_rename",
  "session_move",
  "worktree_create",
  "worktree_list",
  "worktree_remove",
  "models",
  "list_mcp_resources",
  "read_mcp_resource",
  "schedule_create",
  "schedule_list",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
  "automation_create",
  "automation_list",
  "automation_pause",
  "automation_resume",
  "automation_delete",
  "artifact_create",
  "artifact_read",
  "artifact_update",
  "artifact_delete",
])
const OPENCODE_NAMESPACE_PREFIX = "opencode_"

// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/core/src/tool/runtime.ts Since 2.4.0 automations have their own `automation` namespace and session tools `opencode.session`; a Code Mode call names them `automation.list` or `opencode.session.rename`, the registry `automation_list` or `opencode_session_rename`.
export function opencodeNamespaceTool(toolName: ToolName): string | undefined {
  const trimmed = toolName?.trim().toLowerCase().replace(/:\d+$/, "") ?? ""
  const flat = trimmed.replaceAll(".", "_")
  const qualified = flat.startsWith(OPENCODE_NAMESPACE_PREFIX) ? flat.slice(OPENCODE_NAMESPACE_PREFIX.length) : flat
  if (OPENCODE_NAMESPACE_TOOLS.has(qualified)) return qualified
  const name = normalizeToolName(trimmed)
  return OPENCODE_NAMESPACE_TOOLS.has(name) ? name : undefined
}
