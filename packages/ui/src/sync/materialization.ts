import { mergeMessages } from "./optimistic"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const STREAMING_PART_FIELDS = ["text", "output"] as const

type MaterializableMessage = { id: string; role: string }
type MaterializablePart = { id: string; type?: string; kind?: string; raw?: unknown }

export type MaterializedMessageRecord<TMessage extends MaterializableMessage = MaterializableMessage, TPart extends MaterializablePart = MaterializablePart> = {
  info: TMessage
  parts: TPart[]
}

export type MaterializedState<TMessage extends MaterializableMessage = MaterializableMessage, TPart extends MaterializablePart = MaterializablePart> = {
  message: Record<string, TMessage[]>
  part: Record<string, TPart[]>
}

export type MaterializeSessionSnapshotsOptions = {
  skipPartTypes?: ReadonlySet<string>
  mode?: "merge" | "prepend"
}

export type MaterializeSessionSnapshotsResult<TMessage extends MaterializableMessage = MaterializableMessage, TPart extends MaterializablePart = MaterializablePart> = {
  message: Record<string, TMessage[]>
  part: Record<string, TPart[]>
  messages: TMessage[]
  messagesChanged: boolean
  partsChanged: boolean
}

export type SessionMaterializationStatus = {
  hasMessages: boolean
  renderable: boolean
  missingPartMessageIDs: string[]
}

function getPartType(part: MaterializablePart): string {
  const rawType = typeof (part.raw as { type?: unknown } | undefined)?.type === "string"
    ? (part.raw as { type: string }).type
    : undefined
  return rawType ?? part.kind ?? ""
}

function sortParts<TPart extends MaterializablePart>(parts: TPart[], skipPartTypes: ReadonlySet<string>) {
  return parts
    .filter((part) => !!part?.id && !skipPartTypes.has(getPartType(part)))
    .sort((a, b) => cmp(a.id, b.id))
}

function haveEquivalentPartSnapshots<TPart extends MaterializablePart>(left: TPart[] | undefined, right: TPart[]): boolean {
  if (!left) return right.length === 0
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (!leftPart || !rightPart) return false
    if (leftPart.id !== rightPart.id) return false
    if (JSON.stringify(leftPart) !== JSON.stringify(rightPart)) return false
  }

  return true
}

function getPartEndTime(part: MaterializablePart): number | undefined {
  const toolEndedAt = (part as { tool?: { endedAt?: unknown } }).tool?.endedAt
  if (part.kind === "tool" && typeof toolEndedAt === "number") return toolEndedAt
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
    ?? (part.raw as { state?: { time?: { end?: unknown } } } | undefined)?.state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part.raw as { time?: { end?: unknown } } | undefined)?.time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getStringField(part: MaterializablePart, field: "text" | "output"): string | undefined {
  const value = field === "text" && (part.kind === "text" || part.kind === "reasoning")
    ? (part as { text?: unknown }).text
    : field === "output" && part.kind === "tool"
      ? (part as { tool?: { output?: unknown } }).tool?.output
      : (part.raw as Record<string, unknown> | undefined)?.[field]
  return typeof value === "string" ? value : undefined
}

function hasLiveStreamingField(part: MaterializablePart): boolean {
  if (getPartEndTime(part) !== undefined) return false
  return STREAMING_PART_FIELDS.some((field) => {
    const value = getStringField(part, field)
    return typeof value === "string" && value.length > 0
  })
}

function withStringField<TPart extends MaterializablePart>(part: TPart, field: "text" | "output", value: string): TPart {
  const raw = part.raw && typeof part.raw === "object" ? { ...part.raw, [field]: value } : part.raw
  if (field === "text" && (part.kind === "text" || part.kind === "reasoning")) {
    return { ...part, text: value, raw } as TPart
  }
  if (field === "output" && part.kind === "tool") {
    return { ...part, tool: { ...(part as { tool?: object }).tool, output: value }, raw } as TPart
  }
  return { ...part, raw } as TPart
}

function mergeMaterializedPart<TPart extends MaterializablePart>(existing: TPart | undefined, next: TPart): TPart {
  if (!existing || getPartEndTime(next) !== undefined) return next

  let merged: TPart = next
  for (const field of STREAMING_PART_FIELDS) {
    const existingValue = getStringField(existing, field)
    if (!existingValue) continue

    const nextValue = getStringField(next, field)
    if (typeof nextValue === "string" && nextValue.length >= existingValue.length) continue
    if (typeof nextValue === "string" && nextValue.length > 0 && !existingValue.startsWith(nextValue)) continue

    merged = withStringField(merged, field, existingValue)
  }

  return merged
}

function mergeMaterializedParts<TPart extends MaterializablePart>(
  existing: TPart[] | undefined,
  nextParts: TPart[],
  skipPartTypes: ReadonlySet<string>,
  preserveLiveStreamingParts: boolean,
): TPart[] {
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
    (part) => !!part?.id && !snapshotIDs.has(part.id) && !skipPartTypes.has(getPartType(part)) && hasLiveStreamingField(part),
  )
  if (missingLiveParts.length === 0) return mergedParts

  return [...mergedParts, ...missingLiveParts].sort((a, b) => cmp(a.id, b.id))
}

export function materializeSessionSnapshots<TMessage extends MaterializableMessage, TPart extends MaterializablePart>(
  state: MaterializedState<TMessage, TPart>,
  sessionID: string,
  records: MaterializedMessageRecord<TMessage, TPart>[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult<TMessage, TPart> {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const snapshots = records
    .filter((record) => !!record?.info?.id)
    .sort((left, right) => cmp(left.info.id, right.info.id))
  const nextMessages = snapshots.map((record) => record.info)
  const currentMessages = state.message[sessionID] ?? []
  const messages = mergeMessages(currentMessages, nextMessages)
  const messagesChanged = messages !== currentMessages

  let partsChanged = false
  const nextPartState = { ...state.part }
  const isPrepend = options.mode === "prepend"

  for (const record of snapshots) {
    const messageID = record.info.id
    if (isPrepend && nextPartState[messageID]) continue

    const existing = nextPartState[messageID]
    const nextParts = mergeMaterializedParts(
      existing,
      sortParts(record.parts ?? [], skipPartTypes),
      skipPartTypes,
      record.info.role === "assistant",
    )
    if (haveEquivalentPartSnapshots(existing, nextParts)) continue

    if (nextParts.length === 0) {
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
    const parts = state.part[message.id]
    if (!parts || parts.length === 0) {
      missingPartMessageIDs.push(message.id)
    }
  }

  return {
    hasMessages: true,
    renderable: missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}
