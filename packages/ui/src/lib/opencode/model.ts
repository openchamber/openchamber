/**
 * OpenChamber's session domain model.
 *
 * This is the shape every store, reducer, and component works with. OpenCode
 * v2 wire types (`@opencode/client`) never leave the adapter layer: the
 * projection in `./projection.ts` and the event reducer are the only code that
 * knows how the server encodes sessions and messages. Keeping the model here
 * means a server-side rename is an adapter change, not a 200-file change.
 *
 * Messages keep the "message + ordered parts" layout the sync stores are tuned
 * for (`message: Record<sessionID, Message[]>`, `part: Record<messageID,
 * Part[]>`). An assistant message's content items become parts with
 * deterministic ids (see `partIds`), so a streaming delta can address the part
 * it grows without a lookup by position.
 */

import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  FormInfo,
  JsonValue,
  McpServer,
  ModelInfo,
  ModelRef,
  PermissionRequest as PermissionRequestWire,
  PermissionRuleset,
  ProviderInfo,
  SessionForkBoundary,
  SessionRevert,
  SessionStatus as SessionStatusWire,
  SessionStructuredError,
  SkillInfo,
  TokenUsageInfo,
} from "@opencode/client"

// ---------------------------------------------------------------------------
// Catalog / configuration (wire shapes are already stable value objects)
// ---------------------------------------------------------------------------

/**
 * An agent as the UI keys it. On the wire an agent has `id` (`build`), which
 * is what prompts, session switches, and settings refer to, and `name`
 * (`Build`), which is only for display. The UI has always keyed agents by
 * `name`, so the domain record keeps `name` as the machine key (equal to `id`)
 * and carries the wire name as `displayName`.
 */
export type Agent = Omit<AgentInfo, "name"> & { name: string; displayName: string }
export type Command = CommandInfo
export type Skill = SkillInfo
export type Provider = ProviderInfo
export type Model = ModelInfo
export type McpServerStatus = McpServer
/** Version-control facts about a directory the UI shows (current and default branch). */
export type Vcs = { branch?: string; defaultBranch?: string }

/** A project OpenCode knows: its canonical root (`worktree`) and any sandboxes. */
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
/** A discovered configuration source; only `document` entries carry settings. */
export type ConfigDocument = Extract<ConfigEntry, { type: "document" }>
/** One merged configuration document (lowest to highest priority entries folded). */
export type Config = ConfigDocument["info"]
export type ConfigSource = ConfigEntry
export type { JsonValue, ModelRef, PermissionRuleset, TokenUsageInfo }

/** Free-form JSON attached to sessions, messages, and prompts. */
export type Metadata = Record<string, JsonValue>

/**
 * Returns the same object without keys whose value is `undefined`, so domain
 * records built from optional wire fields stay free of phantom properties.
 */
export function compact<T extends object>(value: T): T {
  // SAFETY: only keys with an undefined value are dropped; every remaining
  // key keeps its declared type, so the result still satisfies T.
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionStatus = SessionStatusWire

export type SessionOutcome = "succeeded" | "failed" | "interrupted"

export type Session = {
  id: string
  parentID?: string
  projectID: string
  /** Absolute directory the session runs in (`location.directory` on the wire). */
  directory: string
  /** Optional subdirectory inside `directory` the session is scoped to. */
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

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type StructuredError = SessionStructuredError

type MessageBase = {
  id: string
  sessionID: string
  metadata?: Metadata
}

export type UserMessage = MessageBase & {
  role: "user"
  time: { created: number }
}

export type AssistantFinish = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"

export type AssistantMessage = MessageBase & {
  role: "assistant"
  time: {
    created: number
    /** First streamed token. */
    streamed?: number
    /** Whole step finished (text and every tool call). */
    completed?: number
  }
  agent: string
  providerID: string
  modelID: string
  variant?: string
  finish?: AssistantFinish
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: { attempt: number; at: number; error: StructuredError }
}

/** Context OpenCode injected on the client's behalf (our context attachments land here). */
export type SyntheticMessage = MessageBase & {
  role: "synthetic"
  time: { created: number }
  text: string
  description?: string
}

/** Text OpenCode itself added (instruction updates, notices). */
export type SystemMessage = MessageBase & {
  role: "system"
  time: { created: number }
  text: string
  description?: string
}

export type SkillMessage = MessageBase & {
  role: "skill"
  time: { created: number }
  skill: string
  name: string
  text: string
}

export type ShellMessage = MessageBase & {
  role: "shell"
  time: { created: number; completed?: number }
  shellID: string
  command: string
  status: "running" | "exited" | "timeout" | "killed"
  exit?: number
  output?: { output: string; cursor: number; size: number; truncated: boolean }
}

export type CompactionMessage = MessageBase & {
  role: "compaction"
  time: { created: number }
  status: "running" | "completed" | "failed"
  reason: "auto" | "manual"
  summary: string
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
}

export type AgentSwitchedMessage = MessageBase & {
  role: "agent-switched"
  time: { created: number }
  agent: string
  previous?: string
}

export type ModelSwitchedMessage = MessageBase & {
  role: "model-switched"
  time: { created: number }
  model: ModelRef
  previous?: ModelRef
}

export type LocationSwitchedMessage = MessageBase & {
  role: "location-switched"
  time: { created: number }
  directory: string
  previous?: string
}

/** v2.0.3: the turn ended; `outcome` says how. Carries nothing to render. */
export type IdleMessage = MessageBase & {
  role: "idle"
  time: { created: number }
  outcome: SessionOutcome
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

export type MessageRole = Message["role"]

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

type PartBase = {
  id: string
  sessionID: string
  messageID: string
}

export type TextPart = PartBase & {
  type: "text"
  text: string
  /** Set while the text is still streaming; `end` lands with the final text. */
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

export type AgentPart = PartBase & {
  type: "agent"
  name: string
}

/** Tool arguments as the model produced them. */
export type ToolInput = Record<string, JsonValue>

export type ToolStatePending = {
  status: "pending"
  input: ToolInput
  /** Raw streamed argument JSON while the model is still emitting the call. */
  raw: string
}

export type ToolStateRunning = {
  status: "running"
  input: ToolInput
  metadata?: Metadata
  time: { start: number }
}

export type ToolStateCompleted = {
  status: "completed"
  input: ToolInput
  /** Concatenated text content of the tool result. */
  output: string
  metadata?: Metadata
  time: { start: number; end: number }
  attachments?: FilePart[]
}

export type ToolStateError = {
  status: "error"
  input: ToolInput
  error: string
  /** Partial text content the tool produced before failing, if any. */
  output?: string
  metadata?: Metadata
  time: { start: number; end: number }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = PartBase & {
  type: "tool"
  /** Tool call id assigned by the model provider. */
  callID: string
  /** Tool name (`shell`, `edit`, `openchamber_web`, ...); see `./tools`. */
  tool: string
  state: ToolState
  /** The provider actually executed the call (false for replayed/synthetic calls). */
  executed?: boolean
}

export type Part = TextPart | ReasoningPart | FilePart | AgentPart | ToolPart

export type PartType = Part["type"]

// ---------------------------------------------------------------------------
// Requests the agent makes of the user
// ---------------------------------------------------------------------------

export type PermissionRequest = PermissionRequestWire
export type PermissionReply = "once" | "always" | "reject"

/** OpenCode v2 replaced the question tool with typed forms. */
export type FormRequest = FormInfo

// ---------------------------------------------------------------------------
// Part identity
// ---------------------------------------------------------------------------

/**
 * Deterministic part ids. Text and reasoning items on the wire are addressed
 * by `(assistantMessageID, ordinal)`; tools by their call id. Deriving the part
 * id from those keys lets the reducer grow the right part on a delta without
 * scanning, and lets a projected page and a live stream agree on identity.
 */
export const partIds = {
  text: (messageID: string, ordinal: number) => `${messageID}:text:${ordinal}`,
  reasoning: (messageID: string, ordinal: number) => `${messageID}:reasoning:${ordinal}`,
  tool: (callID: string) => callID,
  userText: (messageID: string) => `${messageID}:text:0`,
  userFile: (messageID: string, index: number) => `${messageID}:file:${index}`,
  userAgent: (messageID: string, index: number) => `${messageID}:agent:${index}`,
} as const

export const FINAL_TOOL_STATUSES: ReadonlySet<ToolState["status"]> = new Set(["completed", "error"])
export const ACTIVE_TOOL_STATUSES: ReadonlySet<ToolState["status"]> = new Set(["pending", "running"])

export const isFinalToolStatus = (status: string): boolean => status === "completed" || status === "error"

/** Assistant reply messages carry parts; every other role is a single record. */
export const hasParts = (message: Message): message is UserMessage | AssistantMessage =>
  message.role === "user" || message.role === "assistant"

export const isConversationRole = (role: MessageRole): role is "user" | "assistant" =>
  role === "user" || role === "assistant"

/**
 * The newest message that is part of the conversation.
 *
 * OpenCode v2 interleaves plumbing roles — `synthetic`, `system`, `skill`,
 * `shell`, `compaction` and the `*-switched` notices — with `user` and
 * `assistant`. "The last message" is only meaningful once those are skipped:
 * a prompt plugin appending a synthetic message must not read as the turn
 * having moved on.
 */
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

/** Same rule as `getLastConversationMessage`, for the `{ info, parts }` records the chat works with. */
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

/** An assistant turn OpenCode started and has not reported completed. */
export const isIncompleteAssistantTurn = (message: Message | undefined): boolean =>
  message?.role === "assistant" && message.time.completed === undefined
