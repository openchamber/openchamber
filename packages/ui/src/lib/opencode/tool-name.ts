export type ToolName = string | undefined

export function normalizeToolName(toolName: ToolName): string {
  const trimmed = toolName?.trim().toLowerCase()
  if (!trimmed) return ""
  const withoutIndex = trimmed.replace(/:\d+$/, "")
  if (!withoutIndex.includes(".")) return withoutIndex
  const segments = withoutIndex.split(".").filter(Boolean)
  return segments[segments.length - 1] ?? withoutIndex
}
