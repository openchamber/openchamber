/**
 * The tools OpenCode v2 ships, and the only place chat rendering is allowed to
 * branch on a tool name.
 *
 * v2 renamed and reshaped the built-ins: `bash` became `shell`, `task` became
 * `subagent`, `apply_patch` became `patch`, and `todowrite`, `todoread`, `lsp`,
 * `multiedit` and `list` are gone. File tools take `path` (not `filePath`), and
 * a tool state no longer carries a server-rendered `title` — the row's
 * description has to be derived from the call's own input and metadata.
 *
 * Everything outside this module works with the predicates and accessors here,
 * so the next rename is one file. Names that are not in this list (MCP servers,
 * OpenChamber's own plugin tools) still flow through the generic renderers;
 * every helper answers "no"/"unknown" for them instead of throwing.
 *
 * A call's `input` and `metadata` are free-form JSON the model and the tool
 * produced, so every read here parses the fields it claims to understand and
 * ignores the rest: one malformed field must not blank a whole tool row.
 */

import { z } from "zod"

import type { Metadata, ToolInput } from "./model"

/** Built-in tool names as the server reports them. */
export const OPENCODE_TOOLS = {
  edit: "edit",
  execute: "execute",
  glob: "glob",
  grep: "grep",
  patch: "patch",
  question: "question",
  read: "read",
  shell: "shell",
  skill: "skill",
  subagent: "subagent",
  webfetch: "webfetch",
  websearch: "websearch",
  write: "write",
  // The `opencode` namespace: tools that manage OpenCode itself. On the wire
  // they arrive as `opencode.<name>`; `normalizeToolName` keeps the last segment.
  sessionRename: "session_rename",
  sessionMove: "session_move",
  models: "models",
} as const

type OpencodeToolName = (typeof OPENCODE_TOOLS)[keyof typeof OPENCODE_TOOLS]

/** A tool name as it arrives on a part: always a string, sometimes namespaced. */
export type ToolName = string | undefined

/**
 * Comparable form of a tool name: lowercased, without a trailing `:index`
 * dedup suffix, and reduced to the last segment of a namespaced name
 * (`opencode.session_rename` -> `session_rename`).
 */
export function normalizeToolName(toolName: ToolName): string {
  const trimmed = toolName?.trim().toLowerCase()
  if (!trimmed) return ""
  const withoutIndex = trimmed.replace(/:\d+$/, "")
  if (!withoutIndex.includes(".")) return withoutIndex
  const segments = withoutIndex.split(".").filter(Boolean)
  return segments[segments.length - 1] ?? withoutIndex
}

const is = (name: OpencodeToolName) => (toolName: ToolName): boolean => normalizeToolName(toolName) === name

export const isShellTool = is(OPENCODE_TOOLS.shell)
/**
 * Code Mode: one tool that runs a short JS script which calls the MCP and
 * integration tools as functions. The script is `input.code`; what it actually
 * called is `metadata.toolCalls`.
 */
export const isExecuteTool = is(OPENCODE_TOOLS.execute)
export const isSubagentTool = is(OPENCODE_TOOLS.subagent)
export const isQuestionTool = is(OPENCODE_TOOLS.question)
export const isSkillTool = is(OPENCODE_TOOLS.skill)
export const isReadTool = is(OPENCODE_TOOLS.read)
export const isEditTool = is(OPENCODE_TOOLS.edit)
export const isWriteTool = is(OPENCODE_TOOLS.write)
export const isPatchTool = is(OPENCODE_TOOLS.patch)

const FILE_CHANGE_TOOLS = new Set<string>([OPENCODE_TOOLS.edit, OPENCODE_TOOLS.write, OPENCODE_TOOLS.patch])
const EXPLORATION_TOOLS = new Set<string>([
  OPENCODE_TOOLS.read,
  OPENCODE_TOOLS.grep,
  OPENCODE_TOOLS.glob,
  OPENCODE_TOOLS.skill,
])
const WEB_TOOLS = new Set<string>([OPENCODE_TOOLS.webfetch, OPENCODE_TOOLS.websearch])

/** Tools that mutate a file, so a turn counts their result as a change. */
export const isFileChangeTool = (toolName: ToolName): boolean => FILE_CHANGE_TOOLS.has(normalizeToolName(toolName))

/** Tools whose result metadata carries `files: FileDiff.Info[]`. */
export const carriesFileDiffs = (toolName: ToolName): boolean => {
  const name = normalizeToolName(toolName)
  return name === OPENCODE_TOOLS.edit || name === OPENCODE_TOOLS.patch
}

export const isExplorationTool = (toolName: ToolName): boolean => EXPLORATION_TOOLS.has(normalizeToolName(toolName))
export const isWebTool = (toolName: ToolName): boolean => WEB_TOOLS.has(normalizeToolName(toolName))
export const isWebSearchTool = (toolName: ToolName): boolean => normalizeToolName(toolName) === OPENCODE_TOOLS.websearch

/**
 * Tools that block the turn on a form the user must answer. Only `question`
 * does this today; the form itself renders as its own card.
 */
export const blocksOnForm = isQuestionTool

// ---------------------------------------------------------------------------
// Input and metadata accessors
// ---------------------------------------------------------------------------

const optionalText = z.string().trim().min(1).optional().catch(undefined)
const optionalCount = z.number().int().nonnegative().optional().catch(undefined)

const inputSchema = z
  .object({
    // v2 file tools use `path`; the other two keep MCP and plugin tools that
    // use the older naming working.
    path: optionalText,
    filePath: optionalText,
    file_path: optionalText,
    command: optionalText,
    description: optionalText,
    agent: optionalText,
    name: optionalText,
    // `skill` names the skill by `id`; `session_rename` carries `title`,
    // `session_move` a `directory`, `models` a `search` and a `provider`.
    id: optionalText,
    title: optionalText,
    directory: optionalText,
    search: optionalText,
    provider: optionalText,
    patchText: optionalText,
    pattern: optionalText,
    query: optionalText,
    url: optionalText,
    code: optionalText,
    questions: z.array(z.unknown()).optional().catch(undefined),
  })
  .catch({})

const fileDiffSchema = z.object({
  file: optionalText,
  patch: optionalText,
  additions: optionalCount,
  deletions: optionalCount,
  status: z.enum(["added", "deleted", "modified"]).optional().catch(undefined),
})

/**
 * One entry of an `execute` call's `metadata.toolCalls`. `input` is the
 * argument object the script passed; it is kept as compact JSON text because
 * the only consumer renders it on one line.
 */
const executeToolCallSchema = z.object({
  tool: optionalText,
  status: optionalText,
  input: z.unknown().optional().catch(undefined),
})

/** A call's raw arguments before serialization: free-form JSON the script passed. */
type ExecuteToolCallInput = z.infer<typeof executeToolCallSchema>["input"]

const metadataSchema = z
  .object({
    files: z.array(fileDiffSchema.nullable().catch(null)).optional().catch(undefined),
    sessionID: optionalText,
    sessionId: optionalText,
    name: optionalText,
    toolCalls: z.array(executeToolCallSchema.nullable().catch(null)).optional().catch(undefined),
    truncated: z.boolean().optional().catch(undefined),
    outputPath: optionalText,
  })
  .catch({})

type ParsedInput = z.infer<typeof inputSchema>

const readInput = (input: ToolInput | undefined): ParsedInput => inputSchema.parse(input ?? {})

/** One entry of a tool's `metadata.files` (`FileDiff.Info` on the wire). */
export type ToolFileDiff = z.infer<typeof fileDiffSchema> & { file: string }

/**
 * The file a call targets, as the tool reported it. Callers render it relative
 * to the session directory.
 */
export function toolInputPath(input: ToolInput | undefined): string | undefined {
  const parsed = readInput(input)
  return parsed.path ?? parsed.filePath ?? parsed.file_path
}

/**
 * Per-file diffs a completed `edit` or `patch` call reported. Entries without
 * a file are dropped rather than failing the whole list, so one malformed file
 * cannot erase the other files of the same call.
 */
export function toolFileDiffs(metadata: Metadata | undefined): ToolFileDiff[] {
  const files = metadataSchema.parse(metadata ?? {}).files ?? []
  return files.filter((entry): entry is ToolFileDiff => entry !== null && entry.file !== undefined)
}

/** A tool an `execute` script called, as the row and the expanded body show it. */
export type ExecuteToolCall = {
  tool: string
  /** `completed`, `error`, or whatever else the runtime reported. */
  status?: string
  /** The call arguments as compact one-line JSON, absent when there were none. */
  input?: string
}

const MAX_EXECUTE_CALL_INPUT_LENGTH = 160

/**
 * The tools an `execute` script called, in order. Entries without a tool name
 * are dropped rather than failing the list, so one malformed call cannot erase
 * the other calls of the same script.
 */
export function executeToolCalls(metadata: Metadata | undefined): ExecuteToolCall[] {
  const calls = metadataSchema.parse(metadata ?? {}).toolCalls ?? []
  const parsed: ExecuteToolCall[] = []
  for (const call of calls) {
    if (!call?.tool) continue
    const entry: ExecuteToolCall = { tool: call.tool }
    if (call.status) entry.status = call.status
    const json = stringifyOrUndefined(call.input)
    // JSON.stringify never emits a raw newline, so the arguments are already
    // one line; empty arguments say nothing and are left off the row.
    if (json && json !== "{}" && json !== "null") {
      entry.input =
        json.length > MAX_EXECUTE_CALL_INPUT_LENGTH
          ? `${json.slice(0, MAX_EXECUTE_CALL_INPUT_LENGTH)}\u2026`
          : json
    }
    parsed.push(entry)
  }
  return parsed
}

/** `JSON.stringify` that answers `undefined` for anything it cannot serialize. */
function stringifyOrUndefined(value: ExecuteToolCallInput): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/**
 * Where OpenCode wrote an `execute` result it had to cut short, or `null` when
 * the row shows the whole output. The path is shown as plain text: the app has
 * no open-file affordance for a path outside the project.
 */
export function executeOutputTruncation(metadata: Metadata | undefined): { outputPath?: string } | null {
  const parsed = metadataSchema.parse(metadata ?? {})
  if (!parsed.truncated) return null
  return parsed.outputPath ? { outputPath: parsed.outputPath } : {}
}

/** The script an `execute` call ran (`input.code`). */
export function executeScript(input: ToolInput | undefined): string | undefined {
  return readInput(input).code
}

/** The child session a `subagent` call runs in (`metadata.sessionID`). */
export function subagentSessionId(metadata: Metadata | undefined): string | undefined {
  const parsed = metadataSchema.parse(metadata ?? {})
  return parsed.sessionID ?? parsed.sessionId
}

// ---------------------------------------------------------------------------
// Row description
// ---------------------------------------------------------------------------

/**
 * What a tool row shows under the tool name.
 *
 * `path` results are raw paths the caller still renders relative to the
 * session directory (and with a file icon); `text` results are shown as is.
 */
/**
 * What a tool row says under its name. `path`/`text` come straight from the
 * call; `questions`/`files` are counts the UI turns into localized copy.
 */
export type ToolDescription =
  | { kind: "path"; value: string }
  | { kind: "text"; value: string }
  | { kind: "questions"; count: number }
  /** Several files in one call; `files` are the raw paths, `count` their number. */
  | { kind: "files"; count: number; files: string[] }
  /** An `execute` script, described by the tools it called. */
  | { kind: "tools"; calls: Array<{ name: string; count: number }>; overflow: number }

const MAX_COMMAND_LENGTH = 100
/** How many distinct tools an `execute` row names before it counts the rest. */
const MAX_DESCRIBED_TOOL_CALLS = 4
const MAX_TEXT_LENGTH = 120

const text = (value: string | undefined): ToolDescription | null =>
  value ? { kind: "text", value: value.slice(0, MAX_TEXT_LENGTH) } : null

const asPath = (value: string | undefined): ToolDescription | null => (value ? { kind: "path", value } : null)

const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/

/**
 * The files a `patch` call names in its own text (`*** Add File: path` and
 * friends), so the row can describe the call before the tool reports its
 * diffs and when a run ends without them.
 */
export function patchInputFiles(input: ToolInput | undefined): string[] {
  const patchText = readInput(input).patchText
  if (!patchText) return []
  const files: string[] = []
  for (const line of patchText.split("\n")) {
    const match = PATCH_HEADER.exec(line.trim())
    const file = match?.[1]?.trim()
    if (file && !files.includes(file)) files.push(file)
  }
  return files
}

/**
 * The tools an `execute` script called, deduplicated in first-seen order with
 * a repeat count, capped so a long script still fits one row. While the script
 * runs — or when it called nothing — the row falls back to its first line.
 */
function describeExecute(calls: ExecuteToolCall[], code: string | undefined): ToolDescription | null {
  const counts = new Map<string, number>()
  for (const call of calls) {
    counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  }
  if (counts.size === 0) {
    return code ? { kind: "text", value: code.split("\n")[0].slice(0, MAX_COMMAND_LENGTH) } : null
  }
  const named = [...counts].slice(0, MAX_DESCRIBED_TOOL_CALLS).map(([name, count]) => ({ name, count }))
  return { kind: "tools", calls: named, overflow: counts.size - named.length }
}

/**
 * Derives the row description from v2 data alone: no state carries a title any
 * more, so every tool answers from its own input, falling back to the per-tool
 * result metadata and finally to a generic `description` field for MCP tools.
 */
export function toolDescription(
  toolName: ToolName,
  input: ToolInput | undefined,
  metadata: Metadata | undefined,
): ToolDescription | null {
  const name = normalizeToolName(toolName)
  const parsed = readInput(input)

  switch (name) {
    case OPENCODE_TOOLS.shell:
      return parsed.command ? { kind: "text", value: parsed.command.split("\n")[0].slice(0, MAX_COMMAND_LENGTH) } : null

    case OPENCODE_TOOLS.execute:
      return describeExecute(executeToolCalls(metadata), parsed.code)

    // "A short 3-5 word label for the task, displayed to the user".
    case OPENCODE_TOOLS.subagent:
      return text(parsed.description) ?? text(parsed.agent)

    case OPENCODE_TOOLS.patch: {
      const reported = toolFileDiffs(metadata).map((file) => file.file)
      const files = reported.length > 0 ? reported : patchInputFiles(input)
      if (files.length > 1) return { kind: "files", count: files.length, files }
      return asPath(files[0])
    }

    case OPENCODE_TOOLS.edit:
    case OPENCODE_TOOLS.write:
    case OPENCODE_TOOLS.read:
      return asPath(parsed.path ?? parsed.filePath ?? parsed.file_path ?? toolFileDiffs(metadata)[0]?.file)

    case OPENCODE_TOOLS.grep:
    case OPENCODE_TOOLS.glob:
      return text(parsed.pattern)

    case OPENCODE_TOOLS.webfetch:
      return text(parsed.url)

    case OPENCODE_TOOLS.websearch:
      return text(parsed.query)

    case OPENCODE_TOOLS.skill:
      return text(metadataSchema.parse(metadata ?? {}).name) ?? text(parsed.name) ?? text(parsed.id)

    case OPENCODE_TOOLS.sessionRename:
      return text(parsed.title)

    case OPENCODE_TOOLS.sessionMove:
      return asPath(parsed.directory)

    case OPENCODE_TOOLS.models:
      return text(parsed.search) ?? text(parsed.provider)

    case OPENCODE_TOOLS.question: {
      const count = parsed.questions?.length ?? 0
      return count > 0 ? { kind: "questions", count } : null
    }

    // MCP and plugin tools: anything they call a description, then a path.
    default:
      return text(parsed.description) ?? asPath(parsed.path ?? parsed.filePath ?? parsed.file_path)
  }
}
