import type { Event, Session } from '@opencode-ai/sdk/v2/client'
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch'

const INTERNAL_SESSION_KIND = 'walkthrough-inference'
const MAX_TRACKED_INTERNAL_SESSIONS = 10_000
const internalSessionIds = new Map<string, true>()
let internalSessionGeneration = 0

export const getOpenChamberInternalSessionGeneration = (): number => internalSessionGeneration

export const resetOpenChamberInternalSessions = (): void => {
  internalSessionGeneration += 1
  internalSessionIds.clear()
}

const isOpenChamberInternalSession = (session: Pick<Session, 'metadata'> | null | undefined): boolean => {
  // SAFETY: Session.metadata is SDK-owned but intentionally open-ended; this
  // local view reads only our namespaced optional marker without widening it.
  const metadata = session?.metadata as { openchamber?: { internalSession?: { kind?: unknown } } } | undefined
  return metadata?.openchamber?.internalSession?.kind === INTERNAL_SESSION_KIND
}

export const rememberOpenChamberInternalSession = (session: Session, generation = internalSessionGeneration): boolean => {
  if (!isOpenChamberInternalSession(session)) return false
  if (generation !== internalSessionGeneration) return true
  internalSessionIds.delete(session.id)
  internalSessionIds.set(session.id, true)
  while (internalSessionIds.size > MAX_TRACKED_INTERNAL_SESSIONS) {
    const oldest = internalSessionIds.keys().next().value
    if (oldest) internalSessionIds.delete(oldest)
  }
  return true
}

export const visibleOpenCodeSessions = <T extends Session>(sessions: T[], generation = internalSessionGeneration): T[] => (
  sessions.filter((session) => !rememberOpenChamberInternalSession(session, generation))
)

export const isOpenChamberInternalSessionEvent = (
  event: Event,
  generation = internalSessionGeneration,
): boolean => {
  // SAFETY: every OpenCode event carries a properties object; the optional
  // fields below are the union members shared by session-addressed events.
  const properties = (event as { properties?: { info?: Session; sessionID?: string } }).properties
  const info = properties?.info
  const sessionID = properties?.sessionID ?? info?.id
  const currentGeneration = generation === internalSessionGeneration
  if (event.type === 'session.deleted') {
    const hidden = Boolean((info && isOpenChamberInternalSession(info)) || (currentGeneration && sessionID && internalSessionIds.has(sessionID)))
    if (currentGeneration && sessionID) internalSessionIds.delete(sessionID)
    return hidden
  }
  if (info && rememberOpenChamberInternalSession(info, generation)) return true
  return Boolean(currentGeneration && sessionID && internalSessionIds.has(sessionID))
}

subscribeRuntimeEndpointWillChange(resetOpenChamberInternalSessions)
