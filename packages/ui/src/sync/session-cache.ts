import type { FormRequest, Message, Part, PermissionRequest, SessionStatus } from "@/lib/opencode/model"
import { getLastConversationMessage, isIncompleteAssistantTurn } from "@/lib/opencode/model"

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  form: Record<string, FormRequest[] | undefined>
}

export function getProtectedSessionCacheIds(store: SessionCache): Set<string> {
  const protectedIds = new Set<string>()

  for (const [sessionID, status] of Object.entries(store.session_status ?? {})) {
    if (status && status.type !== "idle") {
      protectedIds.add(sessionID)
    }
  }

  for (const [sessionID, permissions] of Object.entries(store.permission ?? {})) {
    if ((permissions?.length ?? 0) > 0) {
      protectedIds.add(sessionID)
    }
  }

  for (const [sessionID, forms] of Object.entries(store.form ?? {})) {
    if ((forms?.length ?? 0) > 0) {
      protectedIds.add(sessionID)
    }
  }

  for (const [sessionID, messages] of Object.entries(store.message ?? {})) {
    // Plumbing roles can land after the assistant message that is still
    // streaming, so protection follows the last conversation message. An idle
    // session is settled even when its last assistant step never completed.
    if (
      store.session_status[sessionID]?.type !== "idle"
      && isIncompleteAssistantTurn(getLastConversationMessage(messages))
    ) {
      protectedIds.add(sessionID)
    }
  }

  return protectedIds
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  const staleMessageIDs = new Set<string>()
  for (const sessionID of stale) {
    for (const message of store.message?.[sessionID] ?? []) {
      if (message?.id) staleMessageIDs.add(message.id)
    }
  }

  for (const messageID of staleMessageIDs) {
    if (store.part) delete store.part[messageID]
  }

  for (const key of Object.keys(store.part ?? {})) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part.sessionID))) continue
    delete store.part[key]
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.form[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep?: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set(input.preserve)
  if (input.keep) {
    keep.add(input.keep)
    input.seen.delete(input.keep)
    input.seen.add(input.keep)
  }
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
