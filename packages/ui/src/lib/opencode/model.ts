
import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  ConnectionInfo,
  FormField as FormFieldWire,
  FormInfo,
  FormValue as FormValueWire,
  FormWhen as FormWhenWire,
  IntegrationExternalMethod as IntegrationExternalMethodWire,
  IntegrationInfo,
  IntegrationKeyMethod as IntegrationKeyMethodWire,
  IntegrationOAuthMethod as IntegrationOAuthMethodWire,
  JsonValue,
  McpServer,
  ModelInfo,
  ModelRef,
  PermissionRequest as PermissionRequestWire,
  PermissionEffect as PermissionEffectWire,
  PermissionRuleset,
  ProviderInfo,
  SessionForkBoundary,
  SessionRevert,
  SessionStatus as SessionStatusWire,
  SessionStructuredError,
  SkillInfo,
  TokenUsageInfo,
} from "@opencode/client"


export type Agent = Omit<AgentInfo, "name"> & { name: string; displayName: string }
export type Command = CommandInfo
export type Skill = SkillInfo
export type Provider = ProviderInfo
export type Integration = IntegrationInfo
export type IntegrationConnection = ConnectionInfo
export type IntegrationExternalMethod = IntegrationExternalMethodWire
export type IntegrationKeyMethod = IntegrationKeyMethodWire
export type IntegrationOAuthMethod = IntegrationOAuthMethodWire
export type FormField = FormFieldWire
export type FormValue = FormValueWire
export type FormWhen = FormWhenWire
export type PermissionEffect = PermissionEffectWire
export type Model = ModelInfo
export type McpServerStatus = McpServer
export type Vcs = { branch?: string; defaultBranch?: string }

export type Project = {
  id: string
  worktree: string
  vcs?: string
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  commands?: { start?: string }
  time: { created: number; updated: number }
  sandboxes: string[]
}
export type ConfigDocument = Extract<ConfigEntry, { type: "document" }>
export type Config = ConfigDocument["info"]
export type { JsonValue, ModelRef, PermissionRuleset, TokenUsageInfo }

export type ModelSelection = Omit<ModelRef, "variant"> & { variant?: string | null }

export function toModelRef({ providerID, id, variant }: ModelSelection): ModelRef {
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function isSameModelRef(current: ModelRef, next: ModelRef): boolean {
  return current.providerID === next.providerID
    && current.id === next.id
    && (current.variant ?? "default") === (next.variant ?? "default")
}

export function findCatalogModel<T extends { id: string; modelID: string }>(
  models: readonly T[] | undefined,
  id: string,
): T | undefined {
  if (!models || !id) return undefined
  return models.find((model) => model.id === id) ?? models.find((model) => model.modelID === id)
}

export type Metadata = Record<string, JsonValue>

export function compact<T extends object>(value: T): T {
  // SAFETY: only keys with an undefined value are dropped; every remaining
  // key keeps its declared type, so the result still satisfies T.
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}


export type SessionStatus = SessionStatusWire

export type SessionOutcome = "succeeded" | "failed" | "interrupted"

export type Session = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  subpath?: string
  title: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsageInfo
  outcome?: SessionOutcome
  time: {
    created: number
    updated: number
    idle?: number
    viewed?: number
    archived?: number
  }
  metadata?: Metadata
  permissions?: PermissionRuleset
  revert?: SessionRevert
  fork?: {
    sessionID: string
    boundary: SessionForkBoundary
  }
}


export type StructuredError = SessionStructuredError

type MessageBase = {
  id: string
  sessionID: string
  metadata?: Metadata
}

export type UserMessage = MessageBase & {
  role: "user"
  time: { created: number }
  skills?: Array<{ id: string; name: string }>
  pending?: true
  steer?: true
}

export const isWaitingSteer = (message: Message): boolean =>
  message.role === "user" && message.pending === true && message.steer === true

export type AssistantFinish = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"

export type AssistantMessage = MessageBase & {
  role: "assistant"
  time: {
    created: number
    firstToken?: number
    streamed?: number
    completed?: number
  }
  agent: string
  providerID: string
  modelID: string
  variant?: string
  finish?: AssistantFinish
  error?: StructuredError
  closedLocally?: true
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: { attempt: number; at: number; error: StructuredError }
}

export type SyntheticMessage = MessageBase & {
  role: "synthetic"
  time: { created: number }
  text: string
  description?: string
  pending?: true
}

type SystemMessage = MessageBase & {
  role: "system"
  time: { created: number }
  text: string
  description?: string
}

type SkillMessage = MessageBase & {
  role: "skill"
  time: { created: number }
  skill: string
  name: string
  text: string
}

type ShellMessage = MessageBase & {
  role: "shell"
  time: { created: number; completed?: number }
  shellID: string
  command: string
  status: "running" | "exited" | "timeout" | "killed"
  exit?: number
  signal?: string
  output?: { output: string; cursor: number; size: number; truncated: boolean }
}

export type CompactionMessage = MessageBase & {
  role: "compaction"
  time: { created: number }
  status: "running" | "completed" | "failed"
  reason: "auto" | "manual"
  summary: string
  model?: ModelRef
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
}

type AgentSwitchedMessage = MessageBase & {
  role: "agent-switched"
  time: { created: number }
  agent: string
  previous?: string
}

type ModelSwitchedMessage = MessageBase & {
  role: "model-switched"
  time: { created: number }
  model: ModelRef
  previous?: ModelRef
}

type LocationSwitchedMessage = MessageBase & {
  role: "location-switched"
  time: { created: number }
  directory: string
  previous?: string
}

type IdleMessage = MessageBase & {
  role: "idle"
  time: { created: number }
  outcome: SessionOutcome
  error?: StructuredError
}

export type Message =
  | UserMessage
  | AssistantMessage
  | SyntheticMessage
  | SystemMessage
  | SkillMessage
  | ShellMessage
  | CompactionMessage
  | AgentSwitchedMessage
  | ModelSwitchedMessage
  | LocationSwitchedMessage
  | IdleMessage

type MessageRole = Message["role"]


type PartBase = {
  id: string
  sessionID: string
  messageID: string
}

export type TextPart = PartBase & {
  type: "text"
  text: string
  time?: { start: number; end?: number }
  metadata?: Metadata
}

export type ReasoningPart = PartBase & {
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export type FilePart = PartBase & {
  type: "file"
  mime: string
  filename?: string
  url: string
}

type AgentPart = PartBase & {
  type: "agent"
  name: string
}

export type ToolInput = Record<string, JsonValue>

type ToolStatePending = {
  status: "pending"
  input: ToolInput
  raw: string
}

type ToolStateRunning = {
  status: "running"
  input: ToolInput
  metadata?: Metadata
  time: { start: number }
}

export type ToolStateCompleted = {
  status: "completed"
  input: ToolInput
  output: string
  metadata?: Metadata
  time: { start: number; end: number }
  attachments?: FilePart[]
}

type ToolStateError = {
  status: "error"
  input: ToolInput
  error: string
  errorType?: string
  errorSource?: "local"
  output?: string
  metadata?: Metadata
  time: { start: number; end: number }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = PartBase & {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  executed?: boolean
}

export type Part = TextPart | ReasoningPart | FilePart | AgentPart | ToolPart

export type PartType = Part["type"]


export type PermissionRequest = PermissionRequestWire
export type PermissionReply = "once" | "always" | "reject"

export type FormRequest = FormInfo


export const partIds = {
  text: (messageID: string, ordinal: number) => `${messageID}:text:${ordinal}`,
  reasoning: (messageID: string, ordinal: number) => `${messageID}:reasoning:${ordinal}`,
  tool: (callID: string) => callID,
  userText: (messageID: string) => `${messageID}:text:0`,
  userFile: (messageID: string, index: number) => `${messageID}:file:${index}`,
  userAgent: (messageID: string, index: number) => `${messageID}:agent:${index}`,
} as const

export const isFinalToolStatus = (status: string): boolean => status === "completed" || status === "error"

export const hasParts = (message: Message): message is UserMessage | AssistantMessage =>
  message.role === "user" || message.role === "assistant"

export const isConversationRole = (role: MessageRole): role is "user" | "assistant" =>
  role === "user" || role === "assistant"

export const getLastConversationMessage = (
  messages: readonly Message[] | undefined,
): UserMessage | AssistantMessage | undefined => {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && hasParts(message)) return message
  }
  return undefined
}

export const getLastConversationRecord = <T extends { info: Message }>(
  records: readonly T[] | undefined,
): T | undefined => {
  if (!records) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.info && hasParts(record.info)) return record
  }
  return undefined
}

export const isIncompleteAssistantTurn = (message: Message | undefined): boolean =>
  message?.role === "assistant" && message.time.completed === undefined
