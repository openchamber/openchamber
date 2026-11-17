import { normalizeProjectPath } from "@/lib/projectResolution"


export const PENDING_ASSIST_MAX_AGE_MS = 5 * 60_000

type PendingAssist = { scope: string; since: number }

const pending = new Map<string, PendingAssist>()
type SettledListener = (isSettledDirectory: (directory: string) => boolean) => void

const settledListeners = new Set<SettledListener>()

const scopeOf = (directory: string): string => normalizeProjectPath(directory) ?? directory

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

export function resetPendingSessionAssists(): void {
  pending.clear()
}
