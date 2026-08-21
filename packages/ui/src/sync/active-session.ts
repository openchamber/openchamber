/**
 * Module-level active session refs for notification viewed-state tracking.
 * Extracted from sync-context.tsx to break import cycles.
 *
 * These track which session the user is currently viewing,
 * used to determine if a notification should be marked as "seen".
 */

let _activeDirectory = ""
let _activeSession = ""

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

export function getActiveSession():
  | { directory: string; sessionId: string }
  | null {
  if (!_activeDirectory || !_activeSession) return null
  return { directory: _activeDirectory, sessionId: _activeSession }
}

export function isActiveSession(directory: string, sessionId: string): boolean {
  return (
    _activeDirectory !== "" &&
    _activeSession !== "" &&
    directory === _activeDirectory &&
    sessionId === _activeSession
  )
}
