import type { Message, Part } from "@/lib/opencode/model"
import { confirmedOptimisticIDs, isPendingInboxMessage, mergeMessages, type OptimisticItem } from "./optimistic"
import type { SessionMaterializationReason } from "./event-reducer"
import { isSameCompletedCompaction } from "./message-ordering"
import { toolContentShellChars } from "@/lib/opencode/toolContentShells"

const STREAMING_PART_FIELDS = ["text", "output"] as const
const ACTIVE_TOOL_STATUSES = new Set(["pending", "running"])
const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"])

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
  placement?: "tail" | "head"
}

export type MaterializeSessionSnapshotsResult = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  messagesChanged: boolean
  partsChanged: boolean
}

export function materializeFetchedSessionPage(
  state: MaterializedState,
  sessionID: string,
  page: { session: Message[]; partsByMessageID: ReadonlyMap<string, Part[]> },
  optimistic: Map<string, OptimisticItem>,
  mode: "merge" | "prepend" | "replace" | "initial",
): MaterializeSessionSnapshotsResult {
  for (const messageID of confirmedOptimisticIDs(page, optimistic.values())) optimistic.delete(messageID)
  const pageIDs = new Set(page.session.map((message) => message.id))
  const outstanding = mode === "initial" || mode === "replace"
    ? (state.message[sessionID] ?? []).filter((message) => !pageIDs.has(message.id) && optimistic.get(message.id)?.message === message)
    : []
  const base = outstanding.length === 0 ? state : {
    ...state,
    message: { ...state.message, [sessionID]: state.message[sessionID].filter((message) => !outstanding.includes(message)) },
  }
  let materialized = materializeSessionSnapshots(
    base,
    sessionID,
    page.session.map((info) => ({ info, parts: page.partsByMessageID.get(info.id) ?? [] })),
    mode === "prepend" ? { mode: "prepend" } : { placement: mode === "merge" ? "tail" : "head" },
  )
  const visibleIDs = new Set(materialized.messages.map((message) => message.id))
  const missingOptimistic = [...new Set([...outstanding.map((message) => message.id), ...optimistic.keys()])]
    .flatMap((messageID) => visibleIDs.has(messageID) ? [] : [optimistic.get(messageID)!])
  if (missingOptimistic.length > 0) {
    materialized = materializeSessionSnapshots(materialized, sessionID, missingOptimistic.map((item) => ({
      info: item.message,
      parts: item.parts,
    })))
  }
  return materialized
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

  if (request.reason === "settled-running-tool") {
    return getStaleRunningToolMessageID(state, sessionID) === request.messageID
  }

  return true
}

export function getStaleRunningToolMessageID(
  state: MaterializedState,
  sessionID: string,
): string | undefined {
  const messages = state.message[sessionID] ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return undefined
    if (message.role !== "assistant") continue
    const hasActiveTool = (state.part[message.id] ?? []).some((part) => {
      if (part.type !== "tool") return false
      const status = (part as { state?: { status?: unknown } }).state?.status
      return typeof status === "string" && ACTIVE_TOOL_STATUSES.has(status)
    })
    return hasActiveTool ? message.id : undefined
  }
  return undefined
}

function filterMaterializedParts(parts: Part[], skipPartTypes: ReadonlySet<string>): Part[] {
  return parts
    .filter((part) => !!part?.id && !skipPartTypes.has(part.type))
}

function finalizeActiveToolsInCompletedMessage(message: Message, parts: Part[]): Part[] {
  if (message.role !== "assistant" || message.time.completed === undefined) return parts

  const completedAt = message.time.completed
  let reconciledParts = parts
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type !== "tool" || !ACTIVE_TOOL_STATUSES.has(part.state.status)) continue

    const start = getPartStateTime(part)?.start ?? completedAt
    if (reconciledParts === parts) reconciledParts = [...parts]
    reconciledParts[index] = {
      ...part,
      state: {
        ...part.state,
        status: "error" as const,
        error: "Interrupted",
        time: { start, end: completedAt },
      },
    }
  }

  return reconciledParts
}

function haveEquivalentPartSnapshots(left: Part[] | undefined, right: Part[]): boolean {
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
  return Array.isArray(attachments) ? attachments : undefined
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

  if (existing.type === "tool" && next.type === "tool") {
    if (
      existing.state.status === next.state.status
      && toolContentShellChars(next) !== null
      && toolContentShellChars(existing) === null
    ) {
      return existing
    }
    const existingStatus = (existing as { state?: { status?: unknown } }).state?.status
    const nextStatus = (next as { state?: { status?: unknown } }).state?.status
    if (
      typeof existingStatus === "string"
      && FINAL_TOOL_STATUSES.has(existingStatus)
      && typeof nextStatus === "string"
      && ACTIVE_TOOL_STATUSES.has(nextStatus)
    ) {
      return existing
    }
    if (existing.state.status === "running" && next.state.status === "pending") {
      return existing
    }
    if (
      existing.state.status === "running"
      && next.state.status === "running"
      && existing.state.metadata !== undefined
      && next.state.metadata === undefined
    ) {
      next = { ...next, state: { ...next.state, metadata: existing.state.metadata } }
    }
  }

  if (getPartEndTime(next) !== undefined) {
    const existingAttachments = getPartStateAttachments(existing)
    if (existingAttachments?.length && getPartStateAttachments(next) === undefined) {
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
  if (existingAttachments?.length && getPartStateAttachments(next) === undefined) {
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

  return [...mergedParts, ...missingLiveParts]
}

function settledCompactionTwin(existing: Message, incoming: readonly Message[], current: readonly Message[]): Message | undefined {
  if (existing.role !== "compaction") return undefined
  const twin = incoming.find((message) => isSameCompletedCompaction(message, existing))
  return twin && !current.some((message) => message.id === twin.id) ? twin : undefined
}

export function materializeSessionSnapshots(
  state: MaterializedState,
  sessionID: string,
  records: MaterializedMessageRecord[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const recordsByMessageID = new Map(
    records
      .filter((record) => !!record?.info?.id)
      .map((record) => [record.info.id, record] as const),
  )
  const nextMessages = [...recordsByMessageID.values()].map((record) => record.info)
  const snapshots = nextMessages.map((message) => recordsByMessageID.get(message.id)!)
  const existingMessages = state.message[sessionID]
  const currentMessages = existingMessages ?? []
  const incomingByID = new Map(nextMessages.map((message) => [message.id, message] as const))
  let reconciledCurrentMessages = currentMessages
  const deliveredWhileAway = new Set<string>()
  const movedIDs = new Set<string>()
  for (let index = 0; index < currentMessages.length; index += 1) {
    const existing = currentMessages[index]
    const incoming = incomingByID.get(existing.id) ?? settledCompactionTwin(existing, nextMessages, currentMessages)
    const delivered = incoming?.role === existing.role && isPendingInboxMessage(existing) && !isPendingInboxMessage(incoming)
    const completed = existing.role === "assistant"
      && incoming?.role === "assistant"
      && incoming.time.completed !== undefined
      && (existing.time.completed === undefined || existing.closedLocally === true)
    const compacted = existing.role === "compaction" && incoming?.role === "compaction"
      && (incoming.id !== existing.id || (existing.status === "running" && incoming.status !== "running"))
    if (!incoming || (!delivered && !completed && !compacted)) continue
    if (delivered && existing.role === "synthetic") deliveredWhileAway.add(existing.id)
    if (delivered) movedIDs.add(existing.id)
    if (reconciledCurrentMessages === currentMessages) reconciledCurrentMessages = [...currentMessages]
    reconciledCurrentMessages[index] = incoming
  }
  if (deliveredWhileAway.size > 0) reconciledCurrentMessages = reconciledCurrentMessages.filter((message) => !deliveredWhileAway.has(message.id))
  const messages = mergeMessages(reconciledCurrentMessages, nextMessages, options.mode === "prepend" ? "older" : options.placement, movedIDs)
  const messagesChanged = messages !== currentMessages || (existingMessages === undefined && snapshots.length === 0)

  let partsChanged = false
  let nextPartState = state.part
  const isPrepend = options.mode === "prepend"

  for (const record of snapshots) {
    const messageID = record.info.id
    if (isPrepend && nextPartState[messageID]) continue

    const isAssistant = record.info.role === "assistant"
    const existing = nextPartState[messageID]
    const mergedParts = mergeMaterializedParts(
      existing,
      filterMaterializedParts(record.parts ?? [], skipPartTypes),
      skipPartTypes,
      isAssistant,
    )
    const nextParts = finalizeActiveToolsInCompletedMessage(record.info, mergedParts)
    const equivalent = existing
      ? haveEquivalentPartSnapshots(existing, nextParts)
      : nextParts.length === 0 && !isAssistant
    if (equivalent) continue

    if (nextPartState === state.part) nextPartState = { ...state.part }

    if (nextParts.length === 0 && !isAssistant) {
      delete nextPartState[messageID]
    } else {
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

export type SessionMaterializationStatusOptions = {
  historyCovered?: boolean
}

export function getSessionMaterializationStatus(
  state: MaterializedState,
  sessionID: string,
  options: SessionMaterializationStatusOptions = {},
): SessionMaterializationStatus {
  const messages = state.message[sessionID]
  if (!messages) {
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }

  const missingPartMessageIDs: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const parts = state.part[message.id]
    if (parts) continue
    if (options.historyCovered && message.time.completed === undefined) continue
    missingPartMessageIDs.push(message.id)
  }

  return {
    hasMessages: true,
    renderable: options.historyCovered !== false && missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}
