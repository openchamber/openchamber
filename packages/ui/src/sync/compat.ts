import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { EMPTY_MESSAGES, EMPTY_PARTS, EMPTY_SESSIONS } from "@/constants/empty"
import type { State } from "./types"
import { toOpenCodeMessageCompat, toOpenCodePartCompat, toOpenCodeSessionCompat } from "./adapters/opencode"

export type SyncSessionRecord = State["session"][number] | HarnessSession
export type SyncMessageRecord = State["message"][string][number] | HarnessMessage
export type SyncPartRecord = State["part"][string][number] | HarnessPart

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
  return mapIfNeeded(state.session, isOpenCodeSession, toOpenCodeCompatibleSession, EMPTY_SESSIONS)
}

export function getOpenCodeCompatibleSession(state: State, sessionID?: string | null): Session | undefined {
  if (!sessionID) return undefined
  const session = state.session.find((candidate) => candidate.id === sessionID)
  return session ? toOpenCodeCompatibleSession(session) : undefined
}

export function getOpenCodeCompatibleMessages(state: State, sessionID: string): Message[] {
  const messages = state.message[sessionID]
  return mapIfNeeded(messages, isOpenCodeMessage, toOpenCodeCompatibleMessage, EMPTY_MESSAGES)
}

export function getOpenCodeCompatibleParts(state: State, messageID: string): Part[] {
  const parts = state.part[messageID]
  return mapIfNeeded(parts, isOpenCodePart, toOpenCodeCompatiblePart, EMPTY_PARTS)
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
  return "projectID" in session || "parentID" in session || "slug" in session
}

function isOpenCodeMessage(message: SyncMessageRecord): message is Message {
  return "sessionID" in message
}

function isOpenCodePart(part: SyncPartRecord): part is Part {
  return "type" in part && "messageID" in part
}
