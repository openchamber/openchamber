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

function storagePrefix(directory: string, serverId?: string): string {
  const serverSegment = serverId && serverId !== 'local' ? `.${serverId}` : ''
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.${head}.${hashCode(directory)}${serverSegment}`
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

type CacheKey = "vcs" | "projectMeta" | "icon" | "sessions"

function cacheKey(directory: string, key: CacheKey, serverId?: string): string {
  return `${storagePrefix(directory, serverId)}.${key}`
}

function readCache<T>(directory: string, key: CacheKey, serverId?: string): T | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(directory, key, serverId))
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function writeCache<T>(directory: string, key: CacheKey, value: T | undefined, serverId?: string): void {
  try {
    const k = cacheKey(directory, key, serverId)
    if (value === undefined) {
      localStorage.removeItem(k)
    } else {
      localStorage.setItem(k, JSON.stringify(value))
    }
  } catch {
    // localStorage quota exceeded — ignore
  }
}

function clearCache(directory: string, serverId?: string): void {
  try {
    const prefix = storagePrefix(directory, serverId)
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    // ignore
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
export function readDirCache(directory: string, serverId?: string): PersistedDirCache {
  return {
    vcs: readCache<VcsInfo>(directory, "vcs", serverId),
    projectMeta: readCache<ProjectMeta>(directory, "projectMeta", serverId),
    icon: readCache<string>(directory, "icon", serverId),
    sessions: readCache<Session[]>(directory, "sessions", serverId),
  }
}

/**
 * Write a capped slice of the directory session list to cache so the sidebar
 * can paint chats instantly on cold start. Refreshed by bootstrap loadSessions.
 */
export function persistSessions(directory: string, sessions: Session[] | undefined, serverId?: string): void {
  if (!sessions || sessions.length === 0) {
    writeCache(directory, "sessions", undefined, serverId)
    return
  }
  // Keep the most recent N by id (ids are time-ordered hex) to bound storage.
  const capped = sessions.length > PERSISTED_SESSION_LIMIT
    ? [...sessions].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, PERSISTED_SESSION_LIMIT)
    : sessions
  writeCache(directory, "sessions", capped, serverId)
}

/** Write vcs info to cache */
export function persistVcs(directory: string, vcs: VcsInfo | undefined, serverId?: string): void {
  writeCache(directory, "vcs", vcs, serverId)
}

/** Write project metadata to cache */
export function persistProjectMeta(directory: string, meta: ProjectMeta | undefined, serverId?: string): void {
  writeCache(directory, "projectMeta", meta, serverId)
}

/** Write icon to cache */
export function persistIcon(directory: string, icon: string | undefined, serverId?: string): void {
  writeCache(directory, "icon", icon, serverId)
}
/** Clear all cached metadata for a directory */
export function clearDirCache(directory: string, serverId?: string): void {
  clearCache(directory, serverId)
}
