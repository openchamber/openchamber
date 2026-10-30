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

import type { JsonValue, Metadata, ToolInput, ToolState } from "./model"

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
export const isEditTool = is(OPENCODE_TOOLS.edit)
export const isWriteTool = is(OPENCODE_TOOLS.write)
export const isPatchTool = is(OPENCODE_TOOLS.patch)

// Tools whose transcript row opens the read file or skill in the app and never
// shows the call's result.
const NAVIGATION_TOOLS = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.skill])
export const isNavigationTool = (toolName: ToolName): boolean => NAVIGATION_TOOLS.has(normalizeToolName(toolName))

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

// ---------------------------------------------------------------------------
// Input and metadata accessors
// ---------------------------------------------------------------------------

const optionalText = z.string().trim().min(1).optional().catch(undefined)
const optionalCount = z.number().int().nonnegative().optional().catch(undefined)

/**
 * A boolean the model produced, read from the input OpenCode stored. A harness
 * can stringify it on the way to the tool, and the generated plugin normalizes
 * exactly the two spellings before its call reaches the server
 * (booleanNormalizationBlock in
 * packages/web/server/lib/agent-tool/runtime.js); OpenCode stores the input as
 * it arrived, so a read of stored input applies the same two spellings here.
 * Every other value reads as absent, leaving the server's strict check the only
 * judge of what the model actually sent. Seen in practice: `awaitAnswer`
 * arrived as "true", the server waited for an answer while the chat read the
 * call as showing an ordinary page, and the wait could only end by
 * interruption (2026-10-25).
 */
const booleanish = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
  .optional()
  .catch(undefined)

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
    // OpenChamber's own tools: one `action` plus its `parameters`.
    action: optionalText,
    parameters: z
      .object({
        title: optionalText,
        name: optionalText,
        prompt: optionalText,
        path: optionalText,
        url: optionalText,
        query: optionalText,
        text: optionalText,
        selector: optionalText,
        taskId: optionalText,
        link: z.object({ identifier: optionalText, title: optionalText }).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
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
    shellID: optionalText,
    status: optionalText,
    name: optionalText,
    toolCalls: z.array(executeToolCallSchema.nullable().catch(null)).optional().catch(undefined),
    truncated: z.boolean().optional().catch(undefined),
    outputPath: optionalText,
  })
  .catch({})

type ParsedInput = z.infer<typeof inputSchema>

const readInput = (input: ToolInput | undefined): ParsedInput => inputSchema.parse(input ?? {})

const renderPageFields = z.object({
  html: z.string().optional().catch(undefined),
  title: optionalText,
  awaitAnswer: booleanish,
})

// The plugin accepts the inputs inside `parameters` or beside `action`, and an
// explicit `parameters` object wins, so the page is read the same way.
const renderPageInputSchema = renderPageFields
  .extend({ parameters: renderPageFields.optional().catch(undefined) })
  .catch({})

// What the user answered on a page that waited (render.page with
// awaitAnswer), as the plugin records it in the call's metadata.
const pageAnswerSchema = z.union([
  z.object({ answered: z.literal(true), summary: z.string(), data: z.json().catch(null) }),
  z.object({ answered: z.literal(false), reason: z.string().optional().catch(undefined) }),
])

const openChamberResultSchema = z
  .object({
    openchamber: z.object({
      ok: z.boolean().optional().catch(undefined),
      answer: pageAnswerSchema.optional().catch(undefined),
    }).optional().catch(undefined),
  })
  .catch({})

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

/** Blocking work in a running `execute`, including progress forwarded by its child tool. */
export function executeHasBackgroundableWork(metadata: Metadata | undefined): boolean {
  const parsed = metadataSchema.parse(metadata ?? {})
  // Child progress replaces Code Mode's call list while shell/subagent waits.
  if (parsed.shellID || (parsed.status === "running" && (parsed.sessionID || parsed.sessionId))) return true
  return (parsed.toolCalls ?? []).some((call) => (
    call?.status === "running" && (isShellTool(call.tool) || isSubagentTool(call.tool))
  ))
}

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

const executeRawCallSchema = z
  .object({
    toolCalls: z
      .array(z.object({ tool: optionalText, input: z.json().optional().catch(undefined) }).nullable().catch(null))
      .optional()
      .catch(undefined),
  })
  .catch({})

/** The newest call an `execute` script made, with its arguments as the script passed them. */
export function lastExecuteToolCall(metadata: Metadata | undefined): { tool: string; input?: JsonValue } | undefined {
  const calls = executeRawCallSchema.parse(metadata ?? {}).toolCalls ?? []
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call?.tool) return { tool: call.tool, input: call.input }
  }
  return undefined
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

/** The agent a `subagent` call runs (`input.agent`). */
const isRenderTool = (toolName: ToolName): boolean => toolName === OPENCHAMBER_RENDER_TOOL

/** Where a page stands on the user's answer. */
export type RenderedPageAsk =
  | { kind: "show" }
  | { kind: "waiting" }
  | { kind: "answered"; summary: string; data: JsonValue }
  | { kind: "answered-in-chat" }
  /** The user had written in the chat before the page appeared, so it did not wait. */
  | { kind: "chat-sent-earlier" }
  | { kind: "unanswered" }

// A page sent without a title is named after its own <title>, else its first
// h1 to h3: the server accepts such a call and names it with the same rule
// (renderPageTitleFromHtml in
// packages/web/server/lib/openchamber-control/render-page.js); change both
// together. The server's last resort, "Page", is the chat's own localized word.
const TITLE_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " } as const
const RENDER_PAGE_MAX_TITLE_LENGTH = 120
const elementText = (html: string, pattern: RegExp): string => (pattern.exec(html)?.[1] ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, entity: keyof typeof TITLE_ENTITIES) => TITLE_ENTITIES[entity])
  .replace(/\s+/g, " ")
  .trim()
const pageTitleFromHtml = (html: string): string => (
  elementText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
  || elementText(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)
).slice(0, RENDER_PAGE_MAX_TITLE_LENGTH).trim()

/**
 * The page an `openchamber_render` call showed: present once OpenChamber
 * accepted the call, so a refused or unfinished call keeps its tool row. A
 * page that waits for the user's answer shows while its call runs, since the
 * call runs until the user answers, and after a call that failed while waiting.
 */
export function renderedPage(
  toolName: ToolName,
  state: ToolState,
): { html: string; title: string; ask: RenderedPageAsk } | null {
  if (!isRenderTool(toolName)) return null
  const parsed = renderPageInputSchema.parse(state.input ?? {})
  const html = parsed.parameters?.html ?? parsed.html
  if (!html?.trim()) return null
  // Empty when neither the call nor the page names it; the chat shows its own word then.
  const title = (parsed.parameters?.title ?? parsed.title)?.trim() || pageTitleFromHtml(html)
  // A page that waited stays in the chat when its call ends without an
  // answer (the user stopped the turn), so the question it asked is still there.
  if ((parsed.parameters?.awaitAnswer ?? parsed.awaitAnswer) === true) {
    if (state.status === "running") return { html, title, ask: { kind: "waiting" } }
    if (state.status === "error") return { html, title, ask: { kind: "unanswered" } }
  }
  if (state.status !== "completed") return null
  const result = openChamberResultSchema.parse(state.metadata ?? {}).openchamber
  if (result?.ok !== true) return null
  const answer = result.answer
  if (answer?.answered === true) return { html, title, ask: { kind: "answered", summary: answer.summary, data: answer.data } }
  if (answer?.answered === false) {
    return { html, title, ask: { kind: answer.reason === "chat-sent-earlier" ? "chat-sent-earlier" : "answered-in-chat" } }
  }
  return { html, title, ask: { kind: "show" } }
}

const secretRequestFields = z.object({
  label: optionalText,
  reason: optionalText,
  placeholder: optionalText,
})

// Read like a page's input: inside `parameters` or beside `action`.
const secretRequestInputSchema = secretRequestFields
  .extend({ parameters: secretRequestFields.optional().catch(undefined) })
  .catch({})

/** Where a secret request stands. `not-given`: the user wrote in the chat, or the turn ended first. */
export type SecretRequestState = "waiting" | "saved" | "declined" | "not-given"

// How a secret request ended, as the plugin records it in the call's metadata:
// the server's status, or the plugin's own answer when the user wrote in the
// chat. The file path the agent got is not needed here.
const secretResultSchema = z
  .object({
    openchamber: z.object({
      ok: z.boolean().optional().catch(undefined),
      answer: z.union([
        z.object({ status: z.enum(["saved", "declined"]) }).transform(({ status }): SecretRequestState => status),
        z.object({ answered: z.literal(false) }).transform((): SecretRequestState => "not-given"),
      ]).optional().catch(undefined),
    }).optional().catch(undefined),
  })
  .catch({})

export type RequestedSecret = { label: string; reason: string; placeholder: string | undefined; state: SecretRequestState }

/**
 * The card an `openchamber_secret` call asks on. A call the server refused
 * keeps its tool row, so the refusal stays readable.
 */
export function requestedSecret(toolName: ToolName, state: ToolState): RequestedSecret | null {
  if (toolName !== OPENCHAMBER_SECRET_TOOL) return null
  const parsed = secretRequestInputSchema.parse(state.input ?? {})
  const label = parsed.parameters?.label ?? parsed.label
  const reason = parsed.parameters?.reason ?? parsed.reason
  if (!label || !reason) return null
  const request = { label, reason, placeholder: parsed.parameters?.placeholder ?? parsed.placeholder }
  if (state.status === "running") return { ...request, state: "waiting" }
  if (state.status === "error") return { ...request, state: "not-given" }
  if (state.status !== "completed") return null
  const result = secretResultSchema.parse(state.metadata ?? {}).openchamber
  if (result?.ok !== true || !result.answer) return null
  return { ...request, state: result.answer }
}

export function subagentAgent(input: ToolInput | undefined): string | undefined {
  return readInput(input).agent
}

/** The short label a `subagent` call gives its task (`input.description`). */
export function subagentDescription(input: ToolInput | undefined): string | undefined {
  return readInput(input).description
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

const OPENCHAMBER_RENDER_TOOL = "openchamber_render"
const OPENCHAMBER_SECRET_TOOL = "openchamber_secret"
const OPENCHAMBER_WORKFLOW_TOOL = "openchamber_workflow"
const OPENCHAMBER_IMAGE_TOOL = "openchamber_image"

/** The control, schedule, browser, memory, knowledge, notify, render, image, secret and workflow tools OpenChamber gives a session. */
const OPENCHAMBER_TOOLS = new Set(["openchamber", "openchamber_schedule", "openchamber_web", "openchamber_memory", "openchamber_knowledge", "openchamber_notify", OPENCHAMBER_RENDER_TOOL, OPENCHAMBER_IMAGE_TOOL, OPENCHAMBER_SECRET_TOOL, OPENCHAMBER_WORKFLOW_TOOL])

// The result envelope the agent tool returns as text (`agent-tool/runtime.js`).
const proposedWorkflowResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("workflow.run"),
  data: z.object({ runId: z.string().min(1) }),
})

/**
 * The workflow run an `openchamber_workflow` call proposed with `workflow.run`,
 * or null for any other part. The chat draws that run's card in place of the
 * call's row, so the user approves the plan where the agent asked.
 */
export function proposedWorkflowRunId(toolName: ToolName, state: ToolState): string | null {
  if (toolName !== OPENCHAMBER_WORKFLOW_TOOL || state.status !== "completed") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(state.output)
  } catch {
    return null
  }
  const result = proposedWorkflowResultSchema.safeParse(parsed)
  return result.success ? result.data.data.runId : null
}

// The result envelope of a finished `image.generate` call (`openchamber-control/generate-image.js`).
const generatedImagesResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("image.generate"),
  data: z.object({ images: z.array(z.object({ path: z.string().min(1) })).min(1) }),
})

/** The files an `openchamber_image` call saved, in order; none for any other part. */
export function generatedImagePaths(toolName: ToolName, state: ToolState): string[] {
  if (toolName !== OPENCHAMBER_IMAGE_TOOL || state.status !== "completed") return []
  let parsed: unknown
  try {
    parsed = JSON.parse(state.output)
  } catch {
    return []
  }
  const result = generatedImagesResultSchema.safeParse(parsed)
  return result.success ? result.data.data.images.map((image) => image.path) : []
}

/**
 * Whether the chat draws what a call showed instead of its tool row: a page
 * from `openchamber_render`, the run a `workflow.run` call proposed, the
 * images `image.generate` made, or a secret card from `openchamber_secret`.
 * The user is meant to see all of them, so they are hoisted to the answer when
 * Activity is collapsed.
 */
export const isShownInPlace = (toolName: ToolName, state: ToolState): boolean => (
  renderedPage(toolName, state) !== null
  || proposedWorkflowRunId(toolName, state) !== null
  || generatedImagePaths(toolName, state).length > 0
  || requestedSecret(toolName, state) !== null
)

const openChamberCallSchema = z
  .object({
    action: optionalText,
    awaitAnswer: booleanish,
    parameters: z.object({ awaitAnswer: booleanish }).optional().catch(undefined),
  })
  .catch({})

/** A call to one of OpenChamber's own tools: which tool, the `action` it ran, and whether it waits for the user (a page, or every secret card). */
export type OpenChamberToolCall = { tool: string; action?: string; awaitsAnswer: boolean }

/**
 * The tools of OpenCode's `opencode` namespace, which manage OpenCode itself.
 * They run inside Code Mode, which names them by registry id
 * (`opencode_session_rename`); the dotted form is how the namespace is written.
 */
const OPENCODE_NAMESPACE_TOOLS = new Set([
  "session_rename",
  "session_move",
  "worktree_create",
  "worktree_list",
  "worktree_remove",
  "models",
  "list_mcp_resources",
  "read_mcp_resource",
])
const OPENCODE_NAMESPACE_PREFIX = "opencode_"

/** The bare name (`session_rename`) of a tool in the `opencode` namespace, else `undefined`. */
export function opencodeNamespaceTool(toolName: ToolName): string | undefined {
  const trimmed = toolName?.trim().toLowerCase() ?? ""
  const name = trimmed.startsWith(OPENCODE_NAMESPACE_PREFIX)
    ? trimmed.slice(OPENCODE_NAMESPACE_PREFIX.length)
    : normalizeToolName(trimmed)
  return OPENCODE_NAMESPACE_TOOLS.has(name) ? name : undefined
}

/**
 * The MCP server a tool comes from. OpenCode names an MCP tool
 * `<server>_<tool>`, with every character of the server name outside
 * `[A-Za-z0-9_-]` replaced by `_`. A server name may hold `_` itself, so only
 * the known server names can split the tool name; the longest match wins.
 */
export function mcpToolServer(toolName: ToolName, servers: readonly string[]): string | undefined {
  const trimmed = toolName?.trim() ?? ""
  let match: string | undefined
  for (const server of servers) {
    const prefix = `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_`
    if (trimmed.length > prefix.length && trimmed.startsWith(prefix) && server.length > (match?.length ?? 0)) match = server
  }
  return match
}

/** `null` for every tool that is not OpenChamber's own. */
export function openChamberToolCall(toolName: ToolName, input: JsonValue | undefined): OpenChamberToolCall | null {
  const tool = normalizeToolName(toolName)
  if (!OPENCHAMBER_TOOLS.has(tool)) return null
  const parsed = openChamberCallSchema.parse(input ?? {})
  const awaitsAnswer = tool === OPENCHAMBER_SECRET_TOOL || (parsed.parameters?.awaitAnswer ?? parsed.awaitAnswer) === true
  return { tool, action: parsed.action, awaitsAnswer }
}

/**
 * The action an OpenChamber tool call ran and the one detail that tells calls
 * apart: what was linked, created, saved, opened or asked. Notifications have
 * no action, so their title stands alone.
 */
function describeOpenChamberTool(parsed: ParsedInput): ToolDescription | null {
  const parameters = parsed.parameters
  const link = parameters?.link
  const linked = link ? [link.identifier, link.title].filter(Boolean).join(" ") : undefined
  const detail = linked
    || parameters?.title
    || parameters?.name
    || parameters?.path
    || parameters?.url
    || parameters?.query
    || parameters?.text
    || parameters?.selector
    || parameters?.prompt?.split("\n")[0]
    || parameters?.taskId
    || parsed.title
  const label = [parsed.action, detail].filter(Boolean).join(" · ")
  return label ? { kind: "text", value: label.slice(0, MAX_COMMAND_LENGTH) } : null
}

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

/** Built-ins that never add, remove or move a file. `edit` refuses to create one. */
const LISTING_NEUTRAL_TOOLS = new Set<string>([
  OPENCODE_TOOLS.edit,
  OPENCODE_TOOLS.read,
  OPENCODE_TOOLS.grep,
  OPENCODE_TOOLS.glob,
  OPENCODE_TOOLS.skill,
  OPENCODE_TOOLS.webfetch,
  OPENCODE_TOOLS.websearch,
  OPENCODE_TOOLS.question,
  // A subagent's own calls arrive in its child session.
  OPENCODE_TOOLS.subagent,
  OPENCODE_TOOLS.sessionRename,
  OPENCODE_TOOLS.sessionMove,
  OPENCODE_TOOLS.models,
])

/**
 * The files whose directory listing a finished call may have changed, as the
 * call named them (relative to the session directory, or absolute). `write`
 * may create its file; `patch` adds, deletes and moves, so both the paths in
 * its text and the ones it reported count. An empty list means the call
 * changed no listing. `null` means it could have touched any file: `shell`,
 * `execute`, and every MCP or plugin tool.
 */
export function toolListingChanges(
  toolName: ToolName,
  input: ToolInput | undefined,
  metadata: Metadata | undefined,
): string[] | null {
  const name = normalizeToolName(toolName)
  if (name === OPENCODE_TOOLS.write) {
    const path = toolInputPath(input)
    return path ? [path] : []
  }
  if (name === OPENCODE_TOOLS.patch) {
    return [...new Set([...patchInputFiles(input), ...toolFileDiffs(metadata).map((file) => file.file)])]
  }
  return LISTING_NEUTRAL_TOOLS.has(name) ? [] : null
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
      if (OPENCHAMBER_TOOLS.has(name)) return describeOpenChamberTool(parsed)
      return text(parsed.description) ?? asPath(parsed.path ?? parsed.filePath ?? parsed.file_path)
  }
}
