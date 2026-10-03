import type { SyncEvent } from "@/lib/opencode/events"
import { subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"

const BULK_ARCHIVE_ECHO_TTL_MS = 30_000
const pendingEchoes = new Map<string, Map<string, { archivedAt: number; expiresAt: number }>>()

subscribeRuntimeEndpointWillChange(() => pendingEchoes.clear())

export const registerBulkArchiveEchoes = (
  runtimeKey: string,
  sessions: Iterable<{ id: string; archivedAt: number }>,
  now = Date.now(),
): void => {
  let runtimeEchoes = pendingEchoes.get(runtimeKey)
  if (!runtimeEchoes) {
    runtimeEchoes = new Map()
    pendingEchoes.set(runtimeKey, runtimeEchoes)
  }
  for (const session of sessions) {
    runtimeEchoes.set(session.id, {
      archivedAt: session.archivedAt,
      expiresAt: now + BULK_ARCHIVE_ECHO_TTL_MS,
    })
  }
}

export const releaseBulkArchiveEchoes = (runtimeKey: string, sessionIds: Iterable<string>): void => {
  const runtimeEchoes = pendingEchoes.get(runtimeKey)
  if (!runtimeEchoes) return
  for (const sessionId of sessionIds) runtimeEchoes.delete(sessionId)
  if (runtimeEchoes.size === 0) pendingEchoes.delete(runtimeKey)
}

export const shouldConsumeBulkArchiveEcho = (
  event: SyncEvent,
  runtimeKey: string,
  now = Date.now(),
): boolean => {
  if (event.type !== "session.patched") return false
  const { sessionID, patch } = event.properties
  const runtimeEchoes = pendingEchoes.get(runtimeKey)
  const expected = runtimeEchoes?.get(sessionID)
  if (!expected) return false
  if (expected.expiresAt < now) {
    runtimeEchoes?.delete(sessionID)
    if (runtimeEchoes?.size === 0) pendingEchoes.delete(runtimeKey)
    return false
  }
  return patch.time?.archived === expected.archivedAt
}
