import type { Event } from "@opencode-ai/sdk/v2/client"
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
  event: Event,
  runtimeKey: string,
  now = Date.now(),
): boolean => {
  if (event.type !== "session.updated") return false
  const runtimeEchoes = pendingEchoes.get(runtimeKey)
  const expected = runtimeEchoes?.get(event.properties.info.id)
  if (!expected) return false
  if (expected.expiresAt < now) {
    runtimeEchoes?.delete(event.properties.info.id)
    if (runtimeEchoes?.size === 0) pendingEchoes.delete(runtimeKey)
    return false
  }
  return event.properties.info.time.archived === expected.archivedAt
}
