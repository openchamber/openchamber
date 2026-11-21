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

export function opencodeNamespaceTool(toolName: ToolName): string | undefined {
  const trimmed = toolName?.trim().toLowerCase() ?? ""
  const name = trimmed.startsWith(OPENCODE_NAMESPACE_PREFIX)
    ? trimmed.slice(OPENCODE_NAMESPACE_PREFIX.length)
    : normalizeToolName(trimmed)
  return OPENCODE_NAMESPACE_TOOLS.has(name) ? name : undefined
}
