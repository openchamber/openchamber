/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, and icons are cached to localStorage
 * per directory so they survive page reloads. Session summaries deliberately
 * do not live here: Electron's SQLite session index is their only durable
 * source of truth.
 */

import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"

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

type CacheKey = "vcs" | "projectMeta" | "icon"

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
}

/** Read all cached metadata for a directory */
export function readDirCache(directory: string): PersistedDirCache {
  return {
    vcs: readCache<VcsInfo>(directory, "vcs"),
    projectMeta: readCache<ProjectMeta>(directory, "projectMeta"),
    icon: readCache<string>(directory, "icon"),
  }
}

/** Remove the legacy per-directory session list after SQLite takes ownership. */
export function clearLegacySessionCache(directory: string): void {
  try {
    localStorage.removeItem(`${storagePrefix(directory)}.sessions`)
  } catch {
    // Storage is only an obsolete acceleration layer; failure is harmless.
  }
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
