import { normalizeProjectPath } from "@/lib/projectResolution"

// The server writes a session's recap and suggestion a minute after its turn
// ends, reading the session's directory, and announces when it starts and
// stops waiting to (`openchamber.session-assist`). The location release keeps
// a left chat's directory running until then: reading a stopped directory
// starts it again with all its MCP servers.

/**
 * A wait the server never ends for this client (a missed end event) stops
 * holding the directory after the longest real one: the 60 s quiet window, the
 * turn-end check and a 120 s generation, with room to spare.
 */
export const PENDING_ASSIST_MAX_AGE_MS = 5 * 60_000

type PendingAssist = { scope: string; since: number }

const pending = new Map<string, PendingAssist>()
/** Called with a test for the directories whose wait just ended. */
type SettledListener = (isSettledDirectory: (directory: string) => boolean) => void

const settledListeners = new Set<SettledListener>()

const scopeOf = (directory: string): string => normalizeProjectPath(directory) ?? directory

/** Applies the server's announcement; a settled wait notifies the listeners. */
export function applySessionAssistEvent(
  event: { sessionID: string; directory: string | null; pending: boolean },
  resolveDirectory: (sessionId: string) => string | null,
  now = Date.now(),
): void {
  const directory = event.directory ?? resolveDirectory(event.sessionID)
  if (event.pending) {
    if (directory) pending.set(event.sessionID, { scope: scopeOf(directory), since: now })
    return
  }
  const known = pending.get(event.sessionID)
  pending.delete(event.sessionID)
  const scope = directory ? scopeOf(directory) : known?.scope
  if (!scope) return
  const isSettledDirectory = (candidate: string) => scopeOf(candidate) === scope
  for (const listener of settledListeners) listener(isSettledDirectory)
}

/** Whether the server is still to write an assist for a session in `directory`. */
export function hasPendingSessionAssist(directory: string, now = Date.now()): boolean {
  const scope = scopeOf(directory)
  for (const [sessionId, entry] of pending) {
    if (now - entry.since > PENDING_ASSIST_MAX_AGE_MS) {
      pending.delete(sessionId)
      continue
    }
    if (entry.scope === scope) return true
  }
  return false
}

export function subscribeSessionAssistSettled(listener: SettledListener): () => void {
  settledListeners.add(listener)
  return () => settledListeners.delete(listener)
}

/** Another runtime's waits say nothing about the new one. */
export function resetPendingSessionAssists(): void {
  pending.clear()
}
