/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, and icons are cached to localStorage
 * per directory so they survive page reloads.
 * Only metadata is persisted — session/message/part data is always fresh
 * from the server via SSE bootstrap.
 */

import type { Session, VcsInfo } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"

/** Cap persisted session lists so localStorage stays bounded per directory. */
const PERSISTED_SESSION_LIMIT = 50

// ---------------------------------------------------------------------------
// Storage key generation
// ---------------------------------------------------------------------------

function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

function storagePrefix(directory: string): string {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.${head}.${hashCode(directory)}`
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

type CacheKey = "vcs" | "projectMeta" | "icon" | "sessions"

function cacheKey(directory: string, key: CacheKey): string {
  return `${storagePrefix(directory)}.${key}`
}

function readCache<T>(directory: string, key: CacheKey): T | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(directory, key))
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function writeCache<T>(directory: string, key: CacheKey, value: T | undefined): void {
  try {
    const k = cacheKey(directory, key)
    if (value === undefined) {
      localStorage.removeItem(k)
    } else {
      localStorage.setItem(k, JSON.stringify(value))
    }
  } catch {
    // localStorage quota exceeded — ignore
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PersistedDirCache = {
  vcs: VcsInfo | undefined
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  sessions: Session[] | undefined
}

/** Read all cached metadata for a directory */
export function readDirCache(directory: string): PersistedDirCache {
  return {
    vcs: readCache<VcsInfo>(directory, "vcs"),
    projectMeta: readCache<ProjectMeta>(directory, "projectMeta"),
    icon: readCache<string>(directory, "icon"),
    sessions: readCache<Session[]>(directory, "sessions"),
  }
}

/**
 * Write a capped slice of the directory session list to cache so the sidebar
 * can paint chats instantly on cold start. Refreshed by bootstrap loadSessions.
 */
export function persistSessions(directory: string, sessions: Session[] | undefined): void {
  if (!sessions || sessions.length === 0) {
    writeCache(directory, "sessions", undefined)
    return
  }
  // Keep the most recent N by id (ids are time-ordered hex) to bound storage.
  const capped = sessions.length > PERSISTED_SESSION_LIMIT
    ? [...sessions].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, PERSISTED_SESSION_LIMIT)
    : sessions
  writeCache(directory, "sessions", capped)
}

/** Write vcs info to cache */
export function persistVcs(directory: string, vcs: VcsInfo | undefined): void {
  writeCache(directory, "vcs", vcs)
}

/** Write project metadata to cache */
export function persistProjectMeta(directory: string, meta: ProjectMeta | undefined): void {
  writeCache(directory, "projectMeta", meta)
}

/** Write icon to cache */
export function persistIcon(directory: string, icon: string | undefined): void {
  writeCache(directory, "icon", icon)
}

/**
 * Remove a specific session id from the cached session list for a directory.
 *
 * Used by the delete/archive action path to clean up cached sessions when the
 * owning child store may have been evicted (idle timeout). {@link persistSessions}
 * only fires from a live store's subscription, so an evicted store leaves the
 * deleted session in localStorage, which re-seeds the sidebar on next restart
 * and causes a "Session not found" render error (issue #2105).
 */
export function removeSessionFromCache(directory: string, sessionId: string): void {
  const cached = readCache<Session[]>(directory, "sessions")
  if (!cached || cached.length === 0) return
  const filtered = cached.filter((s) => s.id !== sessionId)
  if (filtered.length === cached.length) return // no change
  writeCache(directory, "sessions", filtered.length > 0 ? filtered : undefined)
}
