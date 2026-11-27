import type { Message, Part, Session, SessionStatus, UserMessage } from "@/lib/opencode/model"

export type OptimisticItem = {
  message: Message
  parts: Part[]
  admitted?: true
}

export const createOptimisticUserMessage = (
  sessionID: string,
  id: string,
  created: number,
  steer?: boolean,
): UserMessage => {
  const message: UserMessage = { id, role: "user", sessionID, time: { created } }
  if (steer) {
    message.pending = true
    message.steer = true
  }
  return message
}

export const shouldMarkBusyFromIdle = (status: SessionStatus | undefined, markBusy?: boolean): boolean => (
  markBusy !== false && (!status || status.type === "idle")
)

type OptimisticRollbackPatch = {
  session: Session[]
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_status?: Record<string, SessionStatus>
}

export const createOptimisticRollbackPatch = (
  rollbackStatus: Record<string, SessionStatus>,
  sessionId: string,
  session: Session[],
  message: Record<string, Message[]>,
  part: Record<string, Part[]>,
  restoreIdle: boolean,
): OptimisticRollbackPatch => {
  if (!restoreIdle || rollbackStatus[sessionId]?.type !== "busy") return { session, message, part }
  return {
    session,
    message,
    part,
    session_status: { ...rollbackStatus, [sessionId]: { type: "idle" } },
  }
}

export const mergePendingInboxRecords = (
  current: WindowState,
  sessionID: string,
  items: readonly { info: Message; parts: Part[] | null }[],
  optimistic: ReadonlyMap<string, OptimisticItem>,
): { message: Record<string, Message[]>; part: Record<string, Part[]> } | null => {
  const messages = [...(current.message[sessionID] ?? [])]
  const indexByID = new Map(messages.map((message, index) => [message.id, index] as const))
  const part = { ...current.part }
  let changed = false
  for (const { info, parts } of items) {
    const existingIndex = indexByID.get(info.id)
    if (existingIndex !== undefined) {
      const existing = messages[existingIndex]
      if (optimistic.get(info.id)?.message === existing && !isPendingInboxMessage(existing)) {
        messages[existingIndex] = info
        if (parts) part[info.id] = parts
        changed = true
      }
      continue
    }
    indexByID.set(info.id, messages.length)
    messages.push(info)
    if (parts) part[info.id] = parts
    changed = true
  }
  if (!changed) return null
  return { message: { ...current.message, [sessionID]: messages }, part }
}

type WindowState = { message: Record<string, Message[]>; part: Record<string, Part[]> }
type WindowPage = { session: readonly Message[] }

export const isPendingInboxMessage = (message: Message): boolean =>
  (message.role === "user" || message.role === "synthetic") && message.pending === true

export const isUndelivered = (message: Message, optimistic: ReadonlyMap<string, OptimisticItem>): boolean =>
  isPendingInboxMessage(message) || optimistic.get(message.id)?.message === message

export const retireDeliveredShadows = (messages: readonly Message[], optimistic: Map<string, OptimisticItem>): void => {
  if (optimistic.size === 0) return
  for (const message of messages) {
    if (optimistic.has(message.id) && !isUndelivered(message, optimistic)) optimistic.delete(message.id)
  }
}

export const inboxCandidateIDs = (messages: readonly Message[], optimistic: ReadonlyMap<string, OptimisticItem>): string[] => {
  const pending = messages.filter((message) => isPendingInboxMessage(message) && !optimistic.has(message.id))
  return [
    ...[...optimistic].flatMap(([id, item]) => item.admitted ? [id] : []),
    ...pending.map((message) => message.id),
  ]
}

export const idsOutsideInbox = (
  candidates: readonly string[],
  inbox: readonly { info: { id: string } }[] | null,
): string[] => {
  if (!inbox) return []
  const pending = new Set(inbox.map((item) => item.info.id))
  return candidates.filter((id) => !pending.has(id))
}

export const dropShadowsOutsidePage = (
  optimistic: Map<string, OptimisticItem>,
  settled: readonly string[],
  page: WindowPage,
  heldOutsidePage: readonly Message[] = [],
): void => {
  if (settled.length === 0) return
  const kept = new Set([...page.session, ...heldOutsidePage].map((message) => message.id))
  for (const id of settled) if (!kept.has(id)) optimistic.delete(id)
}

const withoutMessages = <S extends WindowState>(state: S, sessionID: string, isDropped: (message: Message) => boolean): S => {
  const messages = state.message[sessionID]
  const dropped = messages?.filter(isDropped)
  if (!dropped?.length) return state
  const droppedIDs = new Set(dropped.map((message) => message.id))
  const part = { ...state.part }
  for (const messageID of droppedIDs) delete part[messageID]
  return { ...state, message: { ...state.message, [sessionID]: messages.filter((message) => !droppedIDs.has(message.id)) }, part }
}

export const withoutUndeliveredOutsidePage = <S extends WindowState>(
  state: S,
  sessionID: string,
  page: WindowPage,
  settled: readonly string[],
): S => {
  if (settled.length === 0) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const goneIDs = new Set(settled.filter((id) => !pageIDs.has(id)))
  return withoutMessages(state, sessionID, (message) => goneIDs.has(message.id) && isPendingInboxMessage(message))
}

export const withoutHistoryOutsideWindow = <S extends WindowState>(
  state: S,
  sessionID: string,
  page: WindowPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
  heldBeforeRead: ReadonlyMap<string, number>,
): S => {
  const pageIDs = new Set(page.session.map((message) => message.id))
  return withoutMessages(state, sessionID, (message) => (
    !pageIDs.has(message.id)
    && !optimistic.has(message.id)
    && !isPendingInboxMessage(message)
    && heldBeforeRead.get(message.id) === message.time.created
  ))
}

export const withoutEchoedOptimisticRecords = <S extends WindowState>(
  state: S,
  sessionID: string,
  page: WindowPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
): S => {
  const messages = state.message[sessionID]
  if (!messages || optimistic.size === 0) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const kept = messages.filter((message) => (
    !pageIDs.has(message.id) || optimistic.get(message.id)?.message !== message
  ))
  return kept.length === messages.length ? state : { ...state, message: { ...state.message, [sessionID]: kept } }
}

export function confirmedOptimisticIDs(
  page: { session: readonly Message[]; partsByMessageID: ReadonlyMap<string, readonly Part[]> },
  items: Iterable<OptimisticItem>,
): string[] {
  const pageIDs = new Set(page.session.map((message) => message.id))
  const confirmed: string[] = []
  for (const item of items) {
    if (!pageIDs.has(item.message.id)) continue
    const partIDs = new Set((page.partsByMessageID.get(item.message.id) ?? []).map((part) => part.id))
    if (item.parts.every((part) => partIDs.has(part.id))) confirmed.push(item.message.id)
  }
  return confirmed
}

export function mergeMessages<T extends Message>(
  existingMessages: T[],
  incomingMessages: readonly T[],
  placement: "tail" | "head" | "older" = "tail",
  movedIDs: ReadonlySet<string> = new Set(),
): T[] {
  if (incomingMessages.length === 0) return existingMessages
  const existingByID = new Map(existingMessages.map((item) => [item.id, item] as const))
  const incomingIDs = new Set(incomingMessages.map((item) => item.id))
  const settledAnchor = placement === "older"
    ? 0
    : existingMessages.findIndex((item) => incomingIDs.has(item.id) && !movedIDs.has(item.id))
  const anchor = settledAnchor >= 0 ? settledAnchor : existingMessages.findIndex((item) => incomingIDs.has(item.id))
  const index = anchor < 0 ? (placement === "head" ? 0 : existingMessages.length) : anchor
  const messages = [
    ...existingMessages.slice(0, index).filter((item) => !incomingIDs.has(item.id)),
    ...incomingMessages.map((item) => existingByID.get(item.id) ?? item),
    ...existingMessages.slice(index).filter((item) => !incomingIDs.has(item.id)),
  ]
  return messages.length === existingMessages.length && messages.every((item, i) => item === existingMessages[i])
    ? existingMessages
    : messages
}
