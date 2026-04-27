import type { HarnessMessage, HarnessPart } from "@openchamber/harness-contracts"
import { Binary } from "./binary"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: HarnessPart[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

export type OptimisticStore = {
  message: Record<string, HarnessMessage[] | undefined>
  part: Record<string, HarnessPart[] | undefined>
}

export type OptimisticItem = {
  message: HarnessMessage
  parts: HarnessPart[]
}

export type OptimisticAddInput = {
  sessionID: string
  message: HarnessMessage
  parts: HarnessPart[]
}

export type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

export type MessagePage = {
  session: HarnessMessage[]
  part: { id: string; part: HarnessPart[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: HarnessPart[] | undefined, want: HarnessPart[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: HarnessPart[] | undefined, want: HarnessPart[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Apply optimistic add to a mutable draft (for immer/produce) */
export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    if (!result.found) {
      messages.splice(result.index, 0, input.message)
    }
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

/** Apply optimistic remove to a mutable draft (for immer/produce) */
export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

/** Merge two sorted message arrays by id, deduplicating.
 *  Preserves references from `a` for items that already exist — avoids
 *  unnecessary React re-renders when prepending older history. */
export function mergeMessages<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const existing = new Map(a.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of b) {
    if (!existing.has(item.id)) {
      existing.set(item.id, item)
      changed = true
    }
  }
  if (!changed) return a as T[]
  return [...existing.values()].sort((x, y) => cmp(x.id, y.id))
}
