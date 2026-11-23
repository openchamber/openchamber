import type { Message, Part } from "@/lib/opencode/model"

export type OptimisticItem = {
  message: Message
  parts: Part[]
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
