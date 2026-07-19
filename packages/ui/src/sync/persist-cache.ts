/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, icons, and a bounded session-list snapshot are
 * cached to localStorage per runtime and directory so they survive reloads.
 * Message/part data is always loaded from the server.
 */

import type { Session, VcsInfo } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"
import { getRuntimeKey } from "@/lib/runtime-switch"

/** Cap persisted session lists so localStorage stays bounded per directory. */
const PERSISTED_SESSION_LIMIT = 50
const SESSION_CACHE_FALLBACK_LIMITS = [PERSISTED_SESSION_LIMIT, 25, 10, 5, 1] as const

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

function legacyStoragePrefix(directory: string): string {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.${head}.${hashCode(directory)}`
}

function storagePrefix(directory: string): string {
  const runtimeKey = getRuntimeKey() || "local"
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.v2.${head}.${hashCode(`${runtimeKey}\0${directory}`)}`
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

type CacheKey = "vcs" | "projectMeta" | "icon" | "sessions"

function cacheKey(directory: string, key: CacheKey): string {
  return `${storagePrefix(directory)}.${key}`
}

function legacyCacheKey(directory: string, key: CacheKey): string {
  return `${legacyStoragePrefix(directory)}.${key}`
}

function readCache<T>(directory: string, key: CacheKey): T | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(directory, key))
      ?? localStorage.getItem(legacyCacheKey(directory, key))
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
      localStorage.removeItem(legacyCacheKey(directory, key))
    } else {
      localStorage.setItem(k, JSON.stringify(value))
      localStorage.removeItem(legacyCacheKey(directory, key))
    }
  } catch {
    // localStorage quota exceeded — ignore
  }
}

function sessionRecencyTimestamp(session: Session): number {
  const updated = session.time?.updated
  if (typeof updated === "number" && Number.isFinite(updated)) return updated
  const created = session.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : 0
}

function selectRecentSessions(sessions: Session[], limit: number): Session[] {
  if (sessions.length <= limit) return sessions
  const recentIds = new Set(
    [...sessions]
      .sort((left, right) => sessionRecencyTimestamp(right) - sessionRecencyTimestamp(left) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((session) => session.id),
  )
  return sessions.filter((session) => recentIds.has(session.id))
}

function tryWriteCacheValue<T>(key: string, legacyKey: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    localStorage.removeItem(legacyKey)
    return true
  } catch {
    return false
  }
}

function writeSessionCache(directory: string, sessions: Session[]): void {
  const key = cacheKey(directory, "sessions")
  const legacyKey = legacyCacheKey(directory, "sessions")
  const recentSessions = selectRecentSessions(sessions, PERSISTED_SESSION_LIMIT)
  if (tryWriteCacheValue(key, legacyKey, recentSessions)) return

  // Replacing a stale value can fail when unrelated localStorage data has
  // grown. Remove that value and retain as much recent history as still fits.
  try {
    localStorage.removeItem(key)
    localStorage.removeItem(legacyKey)
  } catch {
    return
  }

  for (const limit of SESSION_CACHE_FALLBACK_LIMITS) {
    const candidate = selectRecentSessions(recentSessions, limit)
    if (tryWriteCacheValue(key, legacyKey, candidate)) return
  }

  // An empty v2 value is a tombstone: never resurrect stale legacy sessions.
  tryWriteCacheValue(key, legacyKey, [])
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
  if (!sessions) {
    writeCache(directory, "sessions", undefined)
    return
  }
  writeSessionCache(directory, sessions)
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
