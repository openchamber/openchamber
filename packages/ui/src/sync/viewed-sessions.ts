import { isSurfaceAttended } from "@/lib/surfaceAttention"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { markSessionViewed } from "./notification-store"
import { isSessionUnread } from "./session-unread"
import { getImperativeSessionMessageLoader } from "./session-message-loader"

let _activeDirectory = ""

let _activeSession = ""

const externallyViewedSessions = new Map<string, number>()

const EXTERNAL_VIEW_TTL_MS = 15_000

const viewedSessionKey = (directory: string, sessionId: string) => `${directory}\n${sessionId}`

export function getActiveSession() {
  return { directory: _activeDirectory, sessionId: _activeSession }
}

export function isSessionCacheViewed(directory: string, sessionID: string): boolean {
  return (
    directory === _activeDirectory && sessionID === _activeSession
  ) || (externallyViewedSessions.get(viewedSessionKey(directory, sessionID)) ?? 0) > Date.now()
}

function pruneExternallyViewedSessions(now = Date.now()) {
  for (const [key, expiresAt] of externallyViewedSessions.entries()) {
    if (expiresAt <= now) {
      externallyViewedSessions.delete(key)
    }
  }
}

export function setActiveSession(directory: string, sessionId: string) {
  ensureViewedSessionWatcher()
  const previousDirectory = _activeDirectory
  _activeDirectory = directory
  _activeSession = sessionId
  getImperativeSessionMessageLoader()?.scheduleCacheRetention(previousDirectory)
  getImperativeSessionMessageLoader()?.touchSessionCache({ directory, sessionID: sessionId })
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    getImperativeSessionMessageLoader()?.scheduleCacheRetention(directory)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
  ensureViewedSessionWatcher()
}

export function isDirectoryExternallyViewed(directory: string): boolean {
  pruneExternallyViewedSessions()
  const prefix = `${directory}\n`
  for (const key of externallyViewedSessions.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

export function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) {
    return Boolean(_activeDirectory && _activeSession && directory === _activeDirectory && isSurfaceAttended())
  }
  if (
    _activeDirectory && _activeSession
    && directory === _activeDirectory && sessionId === _activeSession
    && isSurfaceAttended()
  ) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(directory, sessionId))
}

let viewedSessionWatcherInstalled = false

function ensureViewedSessionWatcher() {
  if (viewedSessionWatcherInstalled) return
  viewedSessionWatcherInstalled = true
  useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.entityById === previous.entityById) return
    const seeIfViewed = (directory: string, sessionId: string): void => {
      const session = state.entityById.get(sessionId)
      if (!session || session === previous.entityById.get(sessionId) || !isSessionUnread(session)) return
      if (isViewedInCurrentSession(directory, sessionId)) markSessionViewed(sessionId)
    }
    if (_activeDirectory && _activeSession) seeIfViewed(_activeDirectory, _activeSession)
    for (const key of externallyViewedSessions.keys()) {
      const separator = key.indexOf("\n")
      seeIfViewed(key.slice(0, separator), key.slice(separator + 1))
    }
  })
}

export function getViewedSessionMaterializationTarget(directory: string) {
  if (!_activeDirectory || !_activeSession) return null
  if (directory !== _activeDirectory) return null
  return {
    directory: _activeDirectory,
    sessionId: _activeSession,
  }
}
