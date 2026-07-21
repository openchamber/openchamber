import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeMessages } from "./optimistic"
import type { SessionMaterializationReason } from "./event-reducer"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const STREAMING_PART_FIELDS = ["text", "output"] as const

export type MaterializedMessageRecord = {
  info: Message
  parts: Part[]
}

export type MaterializedState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

export type MaterializeSessionSnapshotsOptions = {
  skipPartTypes?: ReadonlySet<string>
  mode?: "merge" | "prepend"
}

export type MaterializeSessionSnapshotsResult = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  messagesChanged: boolean
  partsChanged: boolean
}

export type SessionMaterializationStatus = {
  hasMessages: boolean
  renderable: boolean
  missingPartMessageIDs: string[]
}

export type SessionMaterializationRequest = {
  reason: SessionMaterializationReason
  messageID?: string
  partID?: string
}

export const getSessionMaterializationRequestKey = (
  runtimeKey: string,
  directory: string,
  sessionID: string,
): string => JSON.stringify([runtimeKey, directory, sessionID])

export function isSessionMaterializationStillNeeded(
  state: MaterializedState,
  sessionID: string,
  request: SessionMaterializationRequest,
): boolean {
  if (request.reason === "empty-assistant-message") {
    return !request.messageID || !Object.prototype.hasOwnProperty.call(state.part, request.messageID)
  }

  if (request.reason === "missing-owning-message") {
    if (!request.messageID) return true
    return !(state.message[sessionID] ?? []).some((message) => message.id === request.messageID)
  }

  if (request.reason === "orphan-delta" || request.reason === "missing-delta-part") {
    if (!request.messageID || !request.partID) return true
    return !(state.part[request.messageID] ?? []).some((part) => part.id === request.partID)
  }

  return true
}

function sortParts(parts: Part[], skipPartTypes: ReadonlySet<string>) {
  return parts
    .filter((part) => !!part?.id && !skipPartTypes.has(part.type))
    .sort((a, b) => cmp(a.id, b.id))
}

function haveEquivalentPartSnapshots(left: Part[] | undefined, right: Part[]): boolean {
  // `undefined` means "parts never fetched", which is NOT equivalent to a
  // fetched-empty snapshot — the empty array must be committed so
  // getSessionMaterializationStatus can tell the two apart.
  if (!left) return false
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (!leftPart || !rightPart) return false
    if (leftPart === rightPart) continue
    if (leftPart.id !== rightPart.id) return false
    if (JSON.stringify(leftPart) !== JSON.stringify(rightPart)) return false
  }

  return true
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getStringField(part: Part, field: "text" | "output"): string | undefined {
  const value = (part as Record<string, unknown>)[field]
  return typeof value === "string" ? value : undefined
}

function getPartStateAttachments(part: Part): Array<unknown> | undefined {
  const state = (part as Record<string, unknown>).state as Record<string, unknown> | undefined
  if (!state) return undefined
  const attachments = state.attachments
  return Array.isArray(attachments) && attachments.length > 0 ? attachments : undefined
}

function hasLiveStreamingField(part: Part): boolean {
  if (getPartEndTime(part) !== undefined) return false
  return STREAMING_PART_FIELDS.some((field) => {
    const value = getStringField(part, field)
    return typeof value === "string" && value.length > 0
  })
}

function getPartStateTime(part: Part): { start?: number; end?: number } | undefined {
  const stateTime = (part as { state?: { time?: { start?: unknown; end?: unknown } } }).state?.time
  if (!stateTime || typeof stateTime !== "object") return undefined
  const start = typeof stateTime.start === "number" ? stateTime.start : undefined
  const end = typeof stateTime.end === "number" ? stateTime.end : undefined
  if (start === undefined && end === undefined) return undefined
  return { start, end }
}

function mergeMaterializedPart(existing: Part | undefined, next: Part): Part {
  if (!existing) return next

  if (getPartEndTime(next) !== undefined) {
    const existingAttachments = getPartStateAttachments(existing)
    if (existingAttachments && !getPartStateAttachments(next)) {
      const nextRecord = { ...next }
      const nextState = { ...((next as Record<string, unknown>).state as Record<string, unknown> ?? {}), attachments: existingAttachments }
      ;(nextRecord as Record<string, unknown>).state = nextState
      return nextRecord
    }
    return next
  }

  let merged: Part = next
  for (const field of STREAMING_PART_FIELDS) {
    const existingValue = getStringField(existing, field)
    if (!existingValue) continue

    const nextValue = getStringField(next, field)
    if (typeof nextValue === "string" && nextValue.length >= existingValue.length) continue
    if (typeof nextValue === "string" && nextValue.length > 0 && !existingValue.startsWith(nextValue)) continue

    if (merged === next) merged = { ...next }
    const mergedRecord = merged as Record<string, unknown>
    mergedRecord[field] = existingValue
  }

  const existingAttachments = getPartStateAttachments(existing)
  if (existingAttachments && !getPartStateAttachments(next)) {
    if (merged === next) merged = { ...next }
    const mergedRecord = merged as Record<string, unknown>
    const nextState = (next as Record<string, unknown>).state as Record<string, unknown> | undefined
    const newState = { ...(nextState ?? {}), attachments: existingAttachments }
    mergedRecord.state = newState
  }

  const existingTime = getPartStateTime(existing)
  if (existingTime) {
    const nextTime = getPartStateTime(next)
    const preservedStart = nextTime?.start ?? existingTime.start
    const preservedEnd = nextTime?.end ?? existingTime.end
    if (preservedStart !== nextTime?.start || preservedEnd !== nextTime?.end) {
      if (merged === next) merged = { ...next }
      const mergedRecord = merged as Record<string, unknown>
      const currentState = (mergedRecord.state as Record<string, unknown> | undefined) ?? (next as Record<string, unknown>).state as Record<string, unknown> | undefined
      const newState = { ...(currentState ?? {}), time: { start: preservedStart, end: preservedEnd } }
      mergedRecord.state = newState
    }
  }

  return merged
}

function mergeMaterializedParts(
  existing: Part[] | undefined,
  nextParts: Part[],
  skipPartTypes: ReadonlySet<string>,
  preserveLiveStreamingParts: boolean,
): Part[] {
  if (!existing || existing.length === 0) return nextParts
  if (!preserveLiveStreamingParts) return nextParts

  const existingByID = new Map(existing.map((part) => [part.id, part]))
  let mergedParts = nextParts
  let changed = false

  for (let index = 0; index < nextParts.length; index += 1) {
    const nextPart = nextParts[index]
    const mergedPart = mergeMaterializedPart(existingByID.get(nextPart.id), nextPart)
    if (mergedPart === nextPart) continue
    if (!changed) mergedParts = [...nextParts]
    mergedParts[index] = mergedPart
    changed = true
  }

  const snapshotIDs = new Set(nextParts.map((part) => part.id))
  const missingLiveParts = existing.filter(
    (part) => !!part?.id && !snapshotIDs.has(part.id) && !skipPartTypes.has(part.type) && hasLiveStreamingField(part),
  )
  if (missingLiveParts.length === 0) return mergedParts

  return [...mergedParts, ...missingLiveParts].sort((a, b) => cmp(a.id, b.id))
}

export function materializeSessionSnapshots(
  state: MaterializedState,
  sessionID: string,
  records: MaterializedMessageRecord[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const snapshots = records
    .filter((record) => !!record?.info?.id)
    .sort((left, right) => cmp(left.info.id, right.info.id))
  const nextMessages = snapshots.map((record) => record.info)
  const existingMessages = state.message[sessionID]
  const currentMessages = existingMessages ?? []
  const messages = mergeMessages(currentMessages, nextMessages)
  const messagesChanged = messages !== currentMessages || (existingMessages === undefined && snapshots.length === 0)

  let partsChanged = false
  let nextPartState = state.part
  const isPrepend = options.mode === "prepend"

  for (const record of snapshots) {
    const messageID = record.info.id
    if (isPrepend && nextPartState[messageID]) continue

    const isAssistant = record.info.role === "assistant"
    const existing = nextPartState[messageID]
    const nextParts = mergeMaterializedParts(
      existing,
      sortParts(record.parts ?? [], skipPartTypes),
      skipPartTypes,
      isAssistant,
    )
    // For non-assistant messages an empty snapshot keeps the old "absent"
    // representation; only assistant messages need the explicit [] marker
    // (getSessionMaterializationStatus checks only assistant messages).
    const equivalent = existing
      ? haveEquivalentPartSnapshots(existing, nextParts)
      : nextParts.length === 0 && !isAssistant
    if (equivalent) continue

    if (nextPartState === state.part) nextPartState = { ...state.part }

    if (nextParts.length === 0 && !isAssistant) {
      delete nextPartState[messageID]
    } else {
      // Store fetched-empty as an explicit [] (not absence): an assistant
      // message the server returned with zero parts (e.g. aborted before any
      // output) is authoritatively empty and must count as renderable, or
      // the ensure-renderable effects retry syncSession forever.
      nextPartState[messageID] = nextParts
    }
    partsChanged = true
  }

  return {
    message: messagesChanged ? { ...state.message, [sessionID]: messages } : state.message,
    part: partsChanged ? nextPartState : state.part,
    messages,
    messagesChanged,
    partsChanged,
  }
}

export function getSessionMaterializationStatus(
  state: MaterializedState,
  sessionID: string,
): SessionMaterializationStatus {
  const messages = state.message[sessionID]
  if (!messages) {
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }

  const missingPartMessageIDs: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    // `undefined` = parts never fetched (not renderable yet). An explicit []
    // is a fetched-empty snapshot (e.g. aborted assistant turn) and counts
    // as renderable — otherwise sessions containing such a message can never
    // reach renderable state and ensure-renderable callers loop forever.
    const parts = state.part[message.id]
    if (!parts) {
      missingPartMessageIDs.push(message.id)
    }
  }

  return {
    hasMessages: true,
    renderable: missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}
