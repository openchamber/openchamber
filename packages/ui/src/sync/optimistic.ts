import type { Message, Part } from "@/lib/opencode/model"

export type OptimisticItem = {
  message: Message
  parts: Part[]
  admitted?: true
}

type WindowState = { message: Record<string, Message[]>; part: Record<string, Part[]> }
type WindowPage = { session: readonly Message[] }

export const deliveredShadowIDs = (
  admitted: readonly string[],
  inbox: readonly { info: { id: string } }[] | null,
): string[] => {
  if (!inbox) return []
  const pending = new Set(inbox.map((item) => item.info.id))
  return admitted.filter((id) => !pending.has(id))
}

export const dropShadowsOutsidePage = (
  optimistic: Map<string, OptimisticItem>,
  delivered: readonly string[],
  page: WindowPage,
  heldOutsidePage: readonly Message[] = [],
): void => {
  if (delivered.length === 0) return
  const kept = new Set([...page.session, ...heldOutsidePage].map((message) => message.id))
  for (const id of delivered) if (!kept.has(id)) optimistic.delete(id)
}

export const withoutHistoryOutsideWindow = <S extends WindowState>(
  state: S,
  sessionID: string,
  page: WindowPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
  preserved: ReadonlySet<string>,
  heldBeforeRead: ReadonlyMap<string, number>,
): S => {
  const messages = state.message[sessionID]
  if (!messages) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const dropped: string[] = []
  const kept = messages.filter((message) => {
    if (pageIDs.has(message.id) || optimistic.has(message.id) || preserved.has(message.id) || heldBeforeRead.get(message.id) !== message.time.created) return true
    dropped.push(message.id)
    return false
  })
  if (dropped.length === 0) return state
  const part = { ...state.part }
  for (const messageID of dropped) delete part[messageID]
  return { ...state, message: { ...state.message, [sessionID]: kept }, part }
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


export const isPendingInboxMessage = (message: Message): boolean =>
  (message.role === "user" || message.role === "synthetic") && message.pending === true

export function prepareOptimisticTrim(messages: readonly Message[], cut: number, optimistic: Map<string, OptimisticItem>): boolean {
  const anchor = messages[cut]
  if (!anchor || isPendingInboxMessage(anchor) || optimistic.get(anchor.id)?.message === anchor) return false

  for (let index = 0; index <= cut && optimistic.size > 0; index += 1) {
    const message = messages[index]
    const item = optimistic.get(message.id)
    if (item && item.message !== message && !isPendingInboxMessage(message)) optimistic.delete(message.id)
  }
  return true
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
): T[] {
  if (incomingMessages.length === 0) return existingMessages
  const existingByID = new Map(existingMessages.map((item) => [item.id, item] as const))
  const incomingIDs = new Set(incomingMessages.map((item) => item.id))
  const anchor = placement === "older" ? 0 : existingMessages.findIndex((item) => incomingIDs.has(item.id))
  const index = anchor < 0 ? (placement === "head" ? 0 : existingMessages.length) : anchor
  const messages = [
    ...existingMessages.slice(0, index),
    ...incomingMessages.map((item) => existingByID.get(item.id) ?? item),
    ...existingMessages.slice(index).filter((item) => !incomingIDs.has(item.id)),
  ]
  return messages.length === existingMessages.length && messages.every((item, i) => item === existingMessages[i])
    ? existingMessages
    : messages
}
