
import { z } from "zod"

import type { JsonValue, Metadata, ToolInput, ToolState } from "./model"
import { opencodeNamespaceTool } from "./opencode-namespace-tools"
import { normalizeToolName, type ToolName } from "./tool-name"

export { normalizeToolName, opencodeNamespaceTool, type ToolName }

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
  todowrite: "todowrite",
  webfetch: "webfetch",
  websearch: "websearch",
  write: "write",
  sessionRename: "session_rename",
  sessionMove: "session_move",
  models: "models",
} as const

type OpencodeToolName = (typeof OPENCODE_TOOLS)[keyof typeof OPENCODE_TOOLS]


const is = (name: OpencodeToolName) => (toolName: ToolName): boolean => normalizeToolName(toolName) === name

export const isShellTool = is(OPENCODE_TOOLS.shell)
export const isExecuteTool = is(OPENCODE_TOOLS.execute)
export const isSubagentTool = is(OPENCODE_TOOLS.subagent)
export const isQuestionTool = is(OPENCODE_TOOLS.question)
export const isSkillTool = is(OPENCODE_TOOLS.skill)
export const isEditTool = is(OPENCODE_TOOLS.edit)
export const isWriteTool = is(OPENCODE_TOOLS.write)
export const isPatchTool = is(OPENCODE_TOOLS.patch)
export const isTodoWriteTool = is(OPENCODE_TOOLS.todowrite)

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

export const isFileChangeTool = (toolName: ToolName): boolean => FILE_CHANGE_TOOLS.has(normalizeToolName(toolName))

export const carriesFileDiffs = (toolName: ToolName): boolean => {
  const name = normalizeToolName(toolName)
  return name === OPENCODE_TOOLS.edit || name === OPENCODE_TOOLS.patch
}

export const isExplorationTool = (toolName: ToolName): boolean => EXPLORATION_TOOLS.has(normalizeToolName(toolName))
export const isWebTool = (toolName: ToolName): boolean => WEB_TOOLS.has(normalizeToolName(toolName))
export const isWebSearchTool = (toolName: ToolName): boolean => normalizeToolName(toolName) === OPENCODE_TOOLS.websearch


const optionalText = z.string().trim().min(1).optional().catch(undefined)
const optionalCount = z.number().int().nonnegative().optional().catch(undefined)

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
  .optional()
  .catch(undefined)

const inputSchema = z
  .object({
    path: optionalText,
    filePath: optionalText,
    file_path: optionalText,
    command: optionalText,
    description: optionalText,
    agent: optionalText,
    name: optionalText,
    id: optionalText,
    server: optionalText,
    uri: optionalText,
    prompt: optionalText,
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
        providerId: optionalText,
        body: optionalText,
        identifier: optionalText,
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

const executeToolCallSchema = z.object({
  tool: optionalText,
  status: optionalText,
  input: z.json().optional().catch(undefined),
})

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

const renderPageShareObjectSchema = z.object({
  recipients: z.array(z.string()).catch([]),
  summary: optionalText,
  expectAnswer: booleanish,
})

const renderPageShareSchema = z.union([
  renderPageShareObjectSchema,
  z.string().transform((text, context) => {
    try {
      return JSON.parse(text)
    } catch {
      context.addIssue({ code: "custom", message: "share is not JSON" })
      return z.NEVER
    }
  }).pipe(renderPageShareObjectSchema),
])

const renderPageFields = z.object({
  html: z.string().optional().catch(undefined),
  ui: z.string().optional().catch(undefined),
  title: optionalText,
  awaitAnswer: booleanish,
  answerLater: booleanish,
  share: renderPageShareSchema.optional().catch(undefined),
})

export type RenderedPageShare = { recipients: string[]; summary?: string; expectAnswer?: boolean }

const renderPageInputSchema = renderPageFields
  .extend({ parameters: renderPageFields.optional().catch(undefined) })
  .catch({})

const jsonObject = z.record(z.string(), z.json())

const spilledCallSchema = z
  .object({ action: z.string() })
  .transform(({ action }): z.infer<typeof renderPageFields> => {
    let revived: unknown
    try {
      revived = JSON.parse(action)
    } catch {
      return {}
    }
    const spilled = jsonObject.safeParse(revived)
    if (!spilled.success) return {}
    const { parameters, ...siblings } = spilled.data
    const nested = jsonObject.safeParse(parameters)
    return renderPageFields.parse({ ...siblings, ...nested.data })
  })
  .catch({})

const spilledCallFields = (input: JsonValue | undefined): z.infer<typeof renderPageFields> => (
  spilledCallSchema.parse(input ?? {})
)

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

export type ToolFileDiff = z.infer<typeof fileDiffSchema> & { file: string }

export function toolInputPath(input: ToolInput | undefined): string | undefined {
  const parsed = readInput(input)
  return parsed.path ?? parsed.filePath ?? parsed.file_path
}

export function toolFileDiffs(metadata: Metadata | undefined): ToolFileDiff[] {
  const files = metadataSchema.parse(metadata ?? {}).files ?? []
  return files.filter((entry): entry is ToolFileDiff => entry !== null && entry.file !== undefined)
}

export type ExecuteToolCall = {
  tool: string
  action?: string
  status?: string
  input?: string
}

const MAX_EXECUTE_CALL_INPUT_LENGTH = 160

export function executeHasBackgroundableWork(metadata: Metadata | undefined): boolean {
  const parsed = metadataSchema.parse(metadata ?? {})
  if (parsed.shellID || (parsed.status === "running" && (parsed.sessionID || parsed.sessionId))) return true
  return (parsed.toolCalls ?? []).some((call) => (
    call?.status === "running" && (isShellTool(call.tool) || isSubagentTool(call.tool))
  ))
}

export function executeToolCalls(metadata: Metadata | undefined): ExecuteToolCall[] {
  const calls = metadataSchema.parse(metadata ?? {}).toolCalls ?? []
  const parsed: ExecuteToolCall[] = []
  for (const call of calls) {
    if (!call?.tool) continue
    const entry: ExecuteToolCall = { tool: call.tool }
    const action = openChamberToolCall(call.tool, call.input)?.action
    if (action) entry.action = action
    if (call.status) entry.status = call.status
    const json = stringifyOrUndefined(call.input)
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
      .array(z.object({ tool: optionalText, status: optionalText, input: z.json().optional().catch(undefined) }).nullable().catch(null))
      .optional()
      .catch(undefined),
    error: z.boolean().optional().catch(undefined),
  })
  .catch({})

export function lastExecuteToolCall(metadata: Metadata | undefined): { tool: string; input?: JsonValue } | undefined {
  const calls = executeRawCallSchema.parse(metadata ?? {}).toolCalls ?? []
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call?.tool) return { tool: call.tool, input: call.input }
  }
  return undefined
}

type SoleCall = { tool: string; input: { [key: string]: JsonValue }; status: string | undefined }

function soleRawCall(metadata: Metadata | undefined): { tool: string; input?: JsonValue; status?: string } | undefined {
  const calls = executeRawCallSchema.parse(metadata ?? {}).toolCalls ?? []
  if (calls.length !== 1 || !calls[0]?.tool) return undefined
  return { ...calls[0], tool: calls[0].tool }
}

function soleCallAs(tool: string, { input, status }: { input?: JsonValue; status?: string }): SoleCall {
  return { tool, input: input && typeof input === "object" && !Array.isArray(input) ? input : {}, status }
}

export function soleNamedCall(metadata: Metadata | undefined): SoleCall | undefined {
  const call = soleRawCall(metadata)
  if (!call) return undefined
  const opencodeTool = opencodeNamespaceTool(call.tool)
  const tool = openChamberToolCall(call.tool, call.input)?.tool ?? (opencodeTool ? `opencode.${opencodeTool}` : undefined)
  return tool ? soleCallAs(tool, call) : undefined
}

export function directToolName(called: string): string {
  return called.replaceAll(".", "_")
}

const CODE_MODE_HELPERS = new Set(["search", "fetch"])

const BUILT_IN_TOOLS = new Set<string>(Object.values(OPENCODE_TOOLS))

export function soleDirectCall(metadata: Metadata | undefined): SoleCall | undefined {
  const call = soleRawCall(metadata)
  if (!call || call.status !== "completed" || CODE_MODE_HELPERS.has(call.tool)) return undefined
  if (executeRawCallSchema.parse(metadata ?? {}).error) return undefined
  const tool = directToolName(call.tool)
  return BUILT_IN_TOOLS.has(normalizeToolName(tool)) ? undefined : soleCallAs(tool, call)
}

export function executeNamespace(metadata: Metadata | undefined): string | undefined {
  const spaces = new Set(executeToolCalls(metadata).map(({ tool }) => {
    if (opencodeNamespaceTool(tool)) return "opencode"
    if (OPENCHAMBER_TOOLS.has(normalizeToolName(tool))) return normalizeToolName(tool)
    const dot = tool.indexOf(".")
    return dot > 0 ? tool.slice(0, dot).toLowerCase() : ""
  }))
  const [space] = spaces
  return spaces.size === 1 && space ? space : undefined
}

function stringifyOrUndefined(value: ExecuteToolCallInput): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export function executeOutputTruncation(metadata: Metadata | undefined): { outputPath?: string } | null {
  const parsed = metadataSchema.parse(metadata ?? {})
  if (!parsed.truncated) return null
  return parsed.outputPath ? { outputPath: parsed.outputPath } : {}
}

export function executeScript(input: ToolInput | undefined): string | undefined {
  return readInput(input).code
}

const todoItemSchema = z.object({
  content: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).catch("pending"),
})

const todoWriteInputSchema = z
  .object({ todos: z.array(todoItemSchema.nullable().catch(null)).optional().catch(undefined) })
  .catch({})

export type TodoItem = z.infer<typeof todoItemSchema>

export function todoWriteItems(input: ToolInput | undefined): TodoItem[] | null {
  const todos = todoWriteInputSchema.parse(input ?? {}).todos
  if (!todos) return null
  return todos.filter((item): item is TodoItem => item !== null)
}

const isRenderTool = (toolName: ToolName): boolean => toolName === OPENCHAMBER_RENDER_TOOL

export type RenderedPageAsk =
  | { kind: "show" }
  | { kind: "waiting"; later?: true }
  | { kind: "answered"; summary: string; data: JsonValue; undelivered?: true }
  | { kind: "answered-in-chat" }
  | { kind: "chat-sent-earlier" }
  | { kind: "not-drawn"; undelivered?: true }
  | { kind: "declined"; undelivered?: true }
  | { kind: "unanswered" }
  | { kind: "later" }

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

export function renderedPage(
  toolName: ToolName,
  state: ToolState,
): { html: string; ui?: string; title: string; ask: RenderedPageAsk; share?: RenderedPageShare } | null {
  if (!isRenderTool(toolName)) return null
  const parsed = renderPageInputSchema.parse(state.input ?? {})
  const spilled = spilledCallFields(state.input)
  const html = parsed.parameters?.html ?? parsed.html ?? spilled.html ?? ""
  const ui = parsed.parameters?.ui ?? parsed.ui ?? spilled.ui
  const page = ui?.trim() ? { html: "", ui } : html.trim() ? { html } : null
  if (!page) return null
  const title = (parsed.parameters?.title ?? parsed.title ?? spilled.title)?.trim() || pageTitleFromHtml(html)
  const share = parsed.parameters?.share ?? parsed.share ?? spilled.share
  if (share) {
    if (state.status !== "completed") return null
    const result = openChamberResultSchema.parse(state.metadata ?? {}).openchamber
    return result?.ok === true ? { ...page, title, ask: { kind: "show" }, share } : null
  }
  if ((parsed.parameters?.awaitAnswer ?? parsed.awaitAnswer ?? spilled.awaitAnswer) === true) {
    if (state.status === "running") return { ...page, title, ask: { kind: "waiting" } }
    if (state.status === "error") return { ...page, title, ask: { kind: "unanswered" } }
  }
  if (state.status !== "completed") return null
  const result = openChamberResultSchema.parse(state.metadata ?? {}).openchamber
  if (result?.ok !== true) return null
  const answer = result.answer
  if ((parsed.parameters?.answerLater ?? parsed.answerLater ?? spilled.answerLater) === true && !answer) return { ...page, title, ask: { kind: "later" } }
  if (answer?.answered === true) return { ...page, title, ask: { kind: "answered", summary: answer.summary, data: answer.data } }
  if (answer?.answered === false) {
    const kind = answer.reason === "chat-sent-earlier" ? "chat-sent-earlier"
      : answer.reason === "ui-not-drawn" ? "not-drawn"
        : answer.reason === "declined" ? "declined"
          : "answered-in-chat"
    return { ...page, title, ask: { kind } }
  }
  return { ...page, title, ask: { kind: "show" } }
}

const secretRequestFields = z.object({
  label: optionalText,
  reason: optionalText,
  placeholder: optionalText,
})

const secretRequestInputSchema = secretRequestFields
  .extend({ parameters: secretRequestFields.optional().catch(undefined) })
  .catch({})

export type RequestedSecret = { label: string; reason: string; placeholder: string | undefined }

const secretRunField = z.object({ env: z.string().trim().min(1), label: z.string().trim().min(1), placeholder: optionalText })

const secretRunFields = z.object({
  program: optionalText,
  args: z.array(z.string()).optional().catch(undefined),
  reason: optionalText,
  inputs: z.array(secretRunField).min(1).optional().catch(undefined),
})

const secretRunInputSchema = secretRunFields
  .extend({ action: z.string().optional().catch(undefined), parameters: secretRunFields.optional().catch(undefined) })
  .catch({})

const isSecretRun = (action: string | undefined) => action === "secret.run" || action === "run"
const isSecretForget = (action: string | undefined) => action === "secret.forget" || action === "forget"

export type RequestedSecretRun = {
  reason: string
  command: string
  program: string
  fields: { env: string; label: string; placeholder: string | undefined }[]
}

export function secretRunCommandLine(program: string, args: readonly string[]): string {
  const hidden = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x61c
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff
  const visible = (value: string) => Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0
    return hidden(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}` : char
  }).join("")
  const word = (value: string) => (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(value) ? value : `'${visible(value).replaceAll("'", "'\\''")}'`)
  return [program, ...args].map(word).join(" ")
}

function secretDetail(action: string | undefined, input: ToolInput | undefined): string | undefined {
  if (action === "secret.run" || action === "run") {
    const parsed = secretRunInputSchema.parse(input ?? {})
    const program = parsed.parameters?.program ?? parsed.program
    return program ? secretRunCommandLine(program, parsed.parameters?.args ?? parsed.args ?? []) : undefined
  }
  if (action === "secret.request" || action === "request") {
    const parsed = secretRequestInputSchema.parse(input ?? {})
    return parsed.parameters?.label ?? parsed.label
  }
  return undefined
}

export function requestedSecretRun(toolName: ToolName, state: ToolState): RequestedSecretRun | null {
  if (toolName !== OPENCHAMBER_SECRET_TOOL || state.status !== "running") return null
  const parsed = secretRunInputSchema.parse(state.input ?? {})
  if (!isSecretRun(parsed.action)) return null
  const program = parsed.parameters?.program ?? parsed.program
  const reason = parsed.parameters?.reason ?? parsed.reason
  const inputs = parsed.parameters?.inputs ?? parsed.inputs
  if (!program || !reason || !inputs) return null
  const args = parsed.parameters?.args ?? parsed.args ?? []
  return {
    reason,
    program,
    command: secretRunCommandLine(program, args),
    fields: inputs.map((field) => ({ env: field.env, label: field.label, placeholder: field.placeholder })),
  }
}

export function requestedSecret(toolName: ToolName, state: ToolState): RequestedSecret | null {
  if (toolName !== OPENCHAMBER_SECRET_TOOL || state.status !== "running") return null
  const action = secretRunInputSchema.parse(state.input ?? {}).action
  if (isSecretRun(action) || isSecretForget(action)) return null
  const parsed = secretRequestInputSchema.parse(state.input ?? {})
  const label = parsed.parameters?.label ?? parsed.label
  const reason = parsed.parameters?.reason ?? parsed.reason
  if (!label || !reason) return null
  return { label, reason, placeholder: parsed.parameters?.placeholder ?? parsed.placeholder }
}

export function subagentAgent(input: ToolInput | undefined): string | undefined {
  return readInput(input).agent
}

export function subagentDescription(input: ToolInput | undefined): string | undefined {
  return readInput(input).description
}

export function subagentSessionId(metadata: Metadata | undefined): string | undefined {
  const parsed = metadataSchema.parse(metadata ?? {})
  return parsed.sessionID ?? parsed.sessionId
}


export type ToolDescription =
  | { kind: "path"; value: string }
  | { kind: "text"; value: string }
  | { kind: "questions"; count: number }
  | { kind: "files"; count: number; files: string[] }
  | { kind: "tools"; calls: Array<{ name: string; count: number; completed: boolean; actions: Array<{ action: string; count: number }> }>; overflow: number }

const MAX_COMMAND_LENGTH = 100
const MAX_DESCRIBED_TOOL_CALLS = 4
const MAX_TEXT_LENGTH = 120

const OPENCHAMBER_RENDER_TOOL = "openchamber_render"
const OPENCHAMBER_SECRET_TOOL = "openchamber_secret"
const OPENCHAMBER_WORKFLOW_TOOL = "openchamber_workflow"
const OPENCHAMBER_IMAGE_TOOL = "openchamber_image"

const OPENCHAMBER_TOOLS = new Set(["openchamber", "openchamber_schedule", "openchamber_web", "openchamber_memory", "openchamber_knowledge", "openchamber_notify", "openchamber_usage", OPENCHAMBER_RENDER_TOOL, OPENCHAMBER_IMAGE_TOOL, OPENCHAMBER_SECRET_TOOL, OPENCHAMBER_WORKFLOW_TOOL])

export const isOpenChamberTool = (toolName: ToolName): boolean => OPENCHAMBER_TOOLS.has(normalizeToolName(toolName))

const proposedWorkflowResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("workflow.run"),
  data: z.object({ runId: z.string().min(1) }),
})

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

const generatedImagesResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal("image.generate"),
  data: z.object({ images: z.array(z.object({ path: z.string().min(1) })).min(1) }),
})

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

export const isShownInPlace = (toolName: ToolName, state: ToolState): boolean => (
  renderedPage(toolName, state) !== null
  || proposedWorkflowRunId(toolName, state) !== null
  || generatedImagePaths(toolName, state).length > 0
  || requestedSecret(toolName, state) !== null
  || requestedSecretRun(toolName, state) !== null
)

const openChamberCallSchema = z
  .object({
    action: optionalText,
    awaitAnswer: booleanish,
    parameters: z.object({ awaitAnswer: booleanish }).optional().catch(undefined),
  })
  .catch({})

export type OpenChamberToolCall = { tool: string; action?: string; awaitsAnswer: boolean }


export function mcpToolServer(toolName: ToolName, servers: readonly string[]): string | undefined {
  const trimmed = toolName?.trim() ?? ""
  let match: string | undefined
  for (const server of servers) {
    const prefix = `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_`
    if (trimmed.length > prefix.length && trimmed.startsWith(prefix) && server.length > (match?.length ?? 0)) match = server
  }
  return match
}

export function openChamberToolCall(toolName: ToolName, input: JsonValue | undefined): OpenChamberToolCall | null {
  const tool = normalizeToolName(toolName)
  if (!OPENCHAMBER_TOOLS.has(tool)) return null
  const parsed = openChamberCallSchema.parse(input ?? {})
  const spilledWait = tool === OPENCHAMBER_RENDER_TOOL ? spilledCallFields(input).awaitAnswer : undefined
  const waits = parsed.parameters?.awaitAnswer ?? parsed.awaitAnswer ?? spilledWait
  const awaitsAnswer = (tool === OPENCHAMBER_SECRET_TOOL && !isSecretForget(parsed.action)) || waits === true
  return { tool, action: parsed.action, awaitsAnswer }
}

function openChamberDetail(parsed: ParsedInput): string | undefined {
  const parameters = parsed.parameters
  const link = parameters?.link
  const linked = link ? [link.identifier, link.title].filter(Boolean).join(" ") : undefined
  const detail = linked
    || parameters?.identifier
    || parameters?.title
    || parameters?.name
    || parameters?.path
    || parameters?.url
    || parameters?.query
    || parameters?.text
    || parameters?.selector
    || parameters?.prompt?.split("\n")[0]
    || parameters?.taskId
    || parameters?.providerId
    || parameters?.body?.split("\n")[0]
    || parsed.title
  return detail || undefined
}

function describeOpencodeNamespaceTool(parsed: ParsedInput): ToolDescription | null {
  const resource = parsed.uri ?? parsed.server
  return text(parsed.name)
    ?? text(parsed.title)
    ?? text(parsed.prompt?.split("\n")[0])
    ?? text(resource)
    ?? asPath(parsed.directory)
    ?? text(parsed.id)
}

function describeOpenChamberTool(parsed: ParsedInput, input: ToolInput | undefined): ToolDescription | null {
  const label = [parsed.action, secretDetail(parsed.action, input) ?? openChamberDetail(parsed)].filter(Boolean).join(" · ")
  return label ? { kind: "text", value: label.slice(0, MAX_COMMAND_LENGTH) } : null
}

const ACTION_PREFIX_BY_TOOL = new Map<string, string>(Object.entries({
  openchamber_memory: "memory",
  openchamber_knowledge: "knowledge",
  openchamber_schedule: "schedule",
  openchamber_notify: "notify",
  openchamber_usage: "usage",
  openchamber_web: "browser",
  openchamber_render: "render",
  openchamber_image: "image",
  openchamber_secret: "secret",
  openchamber_workflow: "workflow",
}))

export function openChamberCallSummary(toolName: ToolName, input: ToolInput | undefined): { action: string | undefined; detail: string | undefined } | null {
  const tool = normalizeToolName(toolName)
  if (!OPENCHAMBER_TOOLS.has(tool)) return null
  const parsed = readInput(input)
  const prefix = ACTION_PREFIX_BY_TOOL.get(tool)
  const raw = parsed.action ?? (tool === "openchamber_notify" ? "send" : undefined)
  const action = raw && prefix && !raw.includes(".") ? `${prefix}.${raw}` : raw
  return { action, detail: secretDetail(action, input) ?? openChamberDetail(parsed) }
}

const text = (value: string | undefined): ToolDescription | null =>
  value ? { kind: "text", value: value.slice(0, MAX_TEXT_LENGTH) } : null

const asPath = (value: string | undefined): ToolDescription | null => (value ? { kind: "path", value } : null)

const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/

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

const LISTING_NEUTRAL_TOOLS = new Set<string>([
  OPENCODE_TOOLS.edit,
  OPENCODE_TOOLS.read,
  OPENCODE_TOOLS.grep,
  OPENCODE_TOOLS.glob,
  OPENCODE_TOOLS.skill,
  OPENCODE_TOOLS.webfetch,
  OPENCODE_TOOLS.websearch,
  OPENCODE_TOOLS.question,
  OPENCODE_TOOLS.todowrite,
  OPENCODE_TOOLS.subagent,
  OPENCODE_TOOLS.sessionRename,
  OPENCODE_TOOLS.sessionMove,
  OPENCODE_TOOLS.models,
])

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

function describeExecute(calls: ExecuteToolCall[], code: string | undefined): ToolDescription | null {
  const counts = new Map<string, { name: string; count: number; completed: boolean; actions: Array<{ action: string; count: number }> }>()
  for (const call of calls) {
    const entry = counts.get(call.tool) ?? { name: call.tool, count: 0, completed: true, actions: [] }
    entry.count += 1
    entry.completed &&= call.status === "completed"
    if (call.action) {
      const seen = entry.actions.find(({ action }) => action === call.action)
      if (seen) seen.count += 1
      else entry.actions.push({ action: call.action, count: 1 })
    }
    counts.set(call.tool, entry)
  }
  if (counts.size === 0) {
    return code ? { kind: "text", value: code.split("\n")[0].slice(0, MAX_COMMAND_LENGTH) } : null
  }
  const named = [...counts.values()].slice(0, MAX_DESCRIBED_TOOL_CALLS)
  return { kind: "tools", calls: named, overflow: counts.size - named.length }
}

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
      return text(parsed.query) ?? text(parsed.search) ?? text(parsed.provider)

    case OPENCODE_TOOLS.question: {
      const count = parsed.questions?.length ?? 0
      return count > 0 ? { kind: "questions", count } : null
    }

    case OPENCODE_TOOLS.todowrite: {
      const items = (todoWriteItems(input) ?? []).filter((item) => item.status !== "cancelled")
      if (items.length === 0) return null
      const done = items.filter((item) => item.status === "completed").length
      const active = items.find((item) => item.status === "in_progress")
      return text(active ? `${done}/${items.length} · ${active.content}` : `${done}/${items.length}`)
    }

    default:
      if (OPENCHAMBER_TOOLS.has(name)) return describeOpenChamberTool(parsed, input)
      if (opencodeNamespaceTool(toolName)) return describeOpencodeNamespaceTool(parsed)
      return text(parsed.description) ?? asPath(parsed.path ?? parsed.filePath ?? parsed.file_path)
  }
}
