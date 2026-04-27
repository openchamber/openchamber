import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { EMPTY_MESSAGES, EMPTY_PARTS, EMPTY_SESSIONS } from "@/constants/empty"
import type { State } from "./types"
import { toOpenCodeMessageCompat, toOpenCodePartCompat, toOpenCodeSessionCompat } from "./adapters/opencode"

export type SyncSessionRecord = HarnessSession | Session
export type SyncMessageRecord = HarnessMessage | Message
export type SyncPartRecord = HarnessPart | Part

export function toOpenCodeCompatibleSession(session: SyncSessionRecord): Session {
  return isOpenCodeSession(session) ? session : toOpenCodeSessionCompat(session)
}

export function toOpenCodeCompatibleMessage(message: SyncMessageRecord): Message {
  return isOpenCodeMessage(message) ? message : toOpenCodeMessageCompat(message)
}

export function toOpenCodeCompatiblePart(part: SyncPartRecord): Part {
  return isOpenCodePart(part) ? part : toOpenCodePartCompat(part)
}

export function getOpenCodeCompatibleSessions(state: State): Session[] {
  return mapIfNeeded(state.session as SyncSessionRecord[], isOpenCodeSession, toOpenCodeCompatibleSession, EMPTY_SESSIONS)
}

export function getOpenCodeCompatibleSession(state: State, sessionID?: string | null): Session | undefined {
  if (!sessionID) return undefined
  const session = state.session.find((candidate) => candidate.id === sessionID)
  return session ? toOpenCodeCompatibleSession(session) : undefined
}

export function getOpenCodeCompatibleMessages(state: State, sessionID: string): Message[] {
  const messages = state.message[sessionID]
  return mapIfNeeded(messages as SyncMessageRecord[] | undefined, isOpenCodeMessage, toOpenCodeCompatibleMessage, EMPTY_MESSAGES)
}

export function getOpenCodeCompatibleParts(state: State, messageID: string): Part[] {
  const parts = state.part[messageID]
  return mapIfNeeded(parts as SyncPartRecord[] | undefined, isOpenCodePart, toOpenCodeCompatiblePart, EMPTY_PARTS)
}

export function getCompatibleSessionDirectory(session: SyncSessionRecord): string | null {
  if ("backendId" in session) {
    return session.directory ?? getRawSessionDirectory(session.raw)
  }
  return getRawSessionDirectory(session)
}

export function getCompatibleSessionParentId(session: SyncSessionRecord): string | null {
  if ("backendId" in session) {
    return session.parentId ?? getRawSessionParentId(session.raw)
  }
  return getRawSessionParentId(session)
}

export function getCompatibleSessionArchivedAt(session: SyncSessionRecord): number | undefined {
  return session.time?.archived
}

export function getCompatibleSessionShareUrl(session: SyncSessionRecord): string | undefined {
  const raw = "backendId" in session ? session.raw : session
  if (!isObject(raw)) return undefined
  const share = raw.share
  if (!isObject(share)) return undefined
  return typeof share.url === "string" ? share.url : undefined
}

export function getCompatibleSessionProjectWorktree(session: SyncSessionRecord): string | null {
  const raw = "backendId" in session ? session.raw : session
  if (!isObject(raw)) return null
  const project = raw.project
  if (!isObject(project)) return null
  return typeof project.worktree === "string" ? project.worktree : null
}

export function getCompatibleSessionSlug(session: SyncSessionRecord): string | undefined {
  const raw = "backendId" in session ? session.raw : session
  if (!isObject(raw)) return undefined
  return typeof raw.slug === "string" ? raw.slug : undefined
}

export function getCompatibleSessionSummary(session: SyncSessionRecord | undefined): unknown {
  if (!session) return undefined
  const raw = "backendId" in session ? session.raw : session
  if (!isObject(raw)) return undefined
  return raw.summary
}

export function getCompatibleMessageId(message: SyncMessageRecord): string {
  return message.id
}

export function getCompatibleMessageRole(message: SyncMessageRecord): "user" | "assistant" | "system" {
  return message.role
}

export function getCompatibleMessageCreatedAt(message: SyncMessageRecord): number {
  return message.time?.created ?? 0
}

export function getCompatiblePartKind(part: SyncPartRecord): string {
  if ("kind" in part) {
    if (part.kind === "linked-session") return "subtask"
    return part.kind
  }
  return typeof part.type === "string" ? part.type : "custom"
}

export function getCompatiblePartText(part: SyncPartRecord): string | undefined {
  if ("kind" in part) {
    if (part.kind === "text" || part.kind === "reasoning") return part.text
    if (part.kind === "custom" && isObject(part.content)) return getRawText(part.content)
    return getRawText(part.raw)
  }
  return getRawText(part)
}

export function getCompatiblePartEndedAt(part: SyncPartRecord): number | undefined {
  if ("kind" in part) {
    if (part.kind === "tool") return part.tool.endedAt
    return getRawPartEndedAt(part.raw)
  }
  return getRawPartEndedAt(part)
}

export function getCompatibleToolName(part: SyncPartRecord): string {
  if ("kind" in part) {
    if (part.kind === "tool") return part.tool.name || "tool"
    return "tool"
  }
  const candidate = part as Partial<{ tool?: unknown; name?: unknown }>
  if (typeof candidate.tool === "string" && candidate.tool.length > 0) return candidate.tool
  return typeof candidate.name === "string" && candidate.name.length > 0 ? candidate.name : "tool"
}

export function getCompatibleToolStatus(part: SyncPartRecord): string | undefined {
  if ("kind" in part) {
    return part.kind === "tool" ? part.tool.status : undefined
  }
  const state = (part as Partial<{ state?: unknown }>).state
  if (!isObject(state)) return undefined
  return typeof state.status === "string" ? state.status : undefined
}

function mapIfNeeded<TInput, TOutput>(
  items: TInput[] | undefined,
  isOutput: (item: TInput) => item is TInput & TOutput,
  map: (item: TInput) => TOutput,
  empty: TOutput[],
): TOutput[] {
  if (!items || items.length === 0) return empty
  for (const item of items) {
    if (!isOutput(item)) return items.map(map)
  }
  return items as unknown as TOutput[]
}

function isOpenCodeSession(session: SyncSessionRecord): session is Session {
  return !("backendId" in session)
}

function isOpenCodeMessage(message: SyncMessageRecord): message is Message {
  return !("sessionId" in message)
}

function isOpenCodePart(part: SyncPartRecord): part is Part {
  return !("kind" in part)
}

function getRawSessionDirectory(raw: unknown): string | null {
  if (!isObject(raw)) return null
  const directory = raw.directory
  if (typeof directory === "string") return directory
  const cwd = raw.cwd
  return typeof cwd === "string" ? cwd : null
}

function getRawSessionParentId(raw: unknown): string | null {
  if (!isObject(raw)) return null
  const parentID = raw.parentID
  return typeof parentID === "string" ? parentID : null
}

function getRawText(raw: unknown): string | undefined {
  if (!isObject(raw)) return undefined
  if (typeof raw.text === "string") return raw.text
  if (typeof raw.content === "string") return raw.content
  return typeof raw.value === "string" ? raw.value : undefined
}

function getRawPartEndedAt(raw: unknown): number | undefined {
  if (!isObject(raw)) return undefined
  const time = raw.time
  if (!isObject(time)) return undefined
  return typeof time.end === "number" ? time.end : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
