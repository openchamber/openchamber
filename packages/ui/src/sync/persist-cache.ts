/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, icons, and a bounded session-list snapshot are
 * cached to localStorage per runtime and directory so they survive reloads.
 * A bounded global snapshot of active sessions outside the managed chats root
 * seeds the global session store for the first sidebar paint.
 * Message/part data is always loaded from the server.
 */

import type { Session, Vcs } from "@/lib/opencode/model"
import type { ProjectMeta } from "./types"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { countSyncPersistenceSerialization, countSyncPersistenceStorageWrite } from "./performance-diagnostics"
import { isChatDirectoryPath } from "@/lib/chatDirectories"
import { isVSCodeRuntime } from "@/lib/desktop"
import { z } from "zod"

/** Cap persisted session lists so localStorage stays bounded per directory. */
const PERSISTED_SESSION_LIMIT = 50
const SESSION_CACHE_FALLBACK_LIMITS = [PERSISTED_SESSION_LIMIT, 25, 10, 5, 1] as const
/**
 * Session snapshots are written at most once per this interval, trailing, and
 * flushed on lifecycle suspension. Chromium commits localStorage at a
 * byte-rate limit, and a session list changes on every streamed step.
 */
const SESSION_PERSIST_THROTTLE_MS = 2_000
const MANAGED_CHATS_CACHE_SCOPE = "openchamber:managed-chats"
/** Most recent sessions the global snapshot keeps, then smaller fallbacks. */
const GLOBAL_SNAPSHOT_LIMITS = [200, 100, 50, 25, 10] as const
/** Serialized size the global snapshot must fit before it is written. */
const GLOBAL_SNAPSHOT_MAX_CHARS = 256 * 1024
const GLOBAL_SNAPSHOT_VERSION = 1

type PendingSessionWrite = {
  runtimeKey: string
  key: string
  sessions: Session[]
  write: () => void
}

const pendingSessionWrites = new Map<string, PendingSessionWrite>()
let pendingSessionWriteTimer: ReturnType<typeof setTimeout> | undefined

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
  return storagePrefixForRuntime(getRuntimeKey() || "local", directory)
}

function storagePrefixForRuntime(runtimeKey: string, directory: string): string {
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
    const currentKey = cacheKey(directory, key)
    if (key === "sessions") {
      const pending = pendingSessionWrites.get(currentKey)
      if (pending) return pending.sessions as T
    }
    const raw = localStorage.getItem(currentKey)
      ?? localStorage.getItem(legacyCacheKey(directory, key))
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function writeCache<T>(directory: string, key: CacheKey, value: T | undefined): void {
  try {
    const currentKey = cacheKey(directory, key)
    if (value === undefined) {
      localStorage.removeItem(currentKey)
      localStorage.removeItem(legacyCacheKey(directory, key))
    } else {
      localStorage.setItem(currentKey, JSON.stringify(value))
      localStorage.removeItem(legacyCacheKey(directory, key))
    }
  } catch {
    // localStorage quota exceeded — ignore
  }
}

/** What recency selection reads from a session or its persisted projection. */
type RecencyRecord = Pick<Session, "id" | "parentID" | "time">

function sessionRecencyTimestamp(session: RecencyRecord): number {
  const updated = session.time?.updated
  if (typeof updated === "number" && Number.isFinite(updated)) return updated
  const created = session.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : 0
}

function recentSessionIds(sessions: readonly RecencyRecord[], limit: number): Set<string> {
  return new Set(
    [...sessions]
      .sort((left, right) => sessionRecencyTimestamp(right) - sessionRecencyTimestamp(left) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((session) => session.id),
  )
}

function selectRecentSessions<T extends RecencyRecord>(sessions: T[], limit: number): T[] {
  if (sessions.length <= limit) return sessions
  const recentIds = recentSessionIds(sessions, limit)
  return sessions.filter((session) => recentIds.has(session.id))
}

/**
 * The `limit` most recent sessions plus every ancestor of a kept child, so a
 * kept subtask never paints without the parent that nests it.
 */
function selectRecentSessionsWithAncestors<T extends RecencyRecord>(sessions: T[], limit: number): T[] {
  if (sessions.length <= limit) return sessions
  const keptIds = recentSessionIds(sessions, limit)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  for (const id of [...keptIds]) {
    let parentID = byId.get(id)?.parentID
    while (parentID && !keptIds.has(parentID) && byId.has(parentID)) {
      keptIds.add(parentID)
      parentID = byId.get(parentID)?.parentID
    }
  }
  return sessions.filter((session) => keptIds.has(session.id))
}

/**
 * A persisted session keeps what the sidebar paints before the authoritative
 * list replaces it. Usage counters, the permission ruleset, and the session
 * assist recap are most of a record's size and none of its row, so they are
 * left out; the authoritative list brings them back.
 */
type PersistedSession = Omit<Session, "cost" | "tokens" | "permissions">

const metadataNamespaceSchema = z.record(z.string(), z.json())

function toPersistedSession(session: Session): PersistedSession {
  // Undefined fields are dropped when the record is serialized.
  const persisted = { ...session, cost: undefined, tokens: undefined, permissions: undefined }
  const metadata = session.metadata
  const namespace = metadata?.openchamber === undefined ? undefined : metadataNamespaceSchema.safeParse(metadata.openchamber).data
  if (!metadata || !namespace || !("assist" in namespace)) return persisted
  const openchamber = Object.fromEntries(Object.entries(namespace).filter(([key]) => key !== "assist"))
  return { ...persisted, metadata: { ...metadata, openchamber } }
}

/** Write a serialized value unless storage already holds exactly that value. */
function tryWriteSerialized(key: string, serialized: string, legacyKey?: string): boolean {
  try {
    if (localStorage.getItem(key) === serialized) return true
    countSyncPersistenceStorageWrite()
    localStorage.setItem(key, serialized)
    if (legacyKey) localStorage.removeItem(legacyKey)
    return true
  } catch {
    return false
  }
}

function tryWriteCacheValue<T>(key: string, legacyKey: string, value: T): boolean {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  countSyncPersistenceSerialization(serialized)
  return tryWriteSerialized(key, serialized, legacyKey)
}

function writeSessionCache(key: string, legacyKey: string, sessions: Session[]): void {
  const recentSessions = selectRecentSessions(sessions, PERSISTED_SESSION_LIMIT).map(toPersistedSession)
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
    if (tryWriteCacheValue(key, legacyKey, selectRecentSessions(recentSessions, limit))) return
  }

  // An empty v2 value is a tombstone: never resurrect stale legacy sessions.
  tryWriteCacheValue(key, legacyKey, [])
}

/** Write every pending session snapshot of the active runtime now. */
export function flushPendingSessionWrites(): void {
  if (pendingSessionWriteTimer !== undefined) {
    clearTimeout(pendingSessionWriteTimer)
    pendingSessionWriteTimer = undefined
  }
  if (pendingSessionWrites.size === 0) return
  const writes = [...pendingSessionWrites.values()]
  pendingSessionWrites.clear()
  const currentRuntimeKey = getRuntimeKey() || "local"
  for (const pending of writes) {
    if (pending.runtimeKey !== currentRuntimeKey) continue
    pending.write()
  }
}

/**
 * Keep the latest snapshot per key and write it at most once per throttle
 * interval. A newer value replaces the pending one without pushing the write
 * back, so a list that changes continuously still reaches storage.
 */
function scheduleSessionWrite(pending: PendingSessionWrite): void {
  for (const [pendingKey, existing] of pendingSessionWrites) {
    if (existing.runtimeKey !== pending.runtimeKey) pendingSessionWrites.delete(pendingKey)
  }
  pendingSessionWrites.set(pending.key, pending)
  pendingSessionWriteTimer ??= setTimeout(flushPendingSessionWrites, SESSION_PERSIST_THROTTLE_MS)
}

function scheduleSessionCacheWrite(directory: string, sessions: Session[]): void {
  const runtimeKey = getRuntimeKey() || "local"
  const key = `${storagePrefixForRuntime(runtimeKey, directory)}.sessions`
  const legacyKey = legacyCacheKey(directory, "sessions")
  scheduleSessionWrite({ runtimeKey, key, sessions, write: () => writeSessionCache(key, legacyKey, sessions) })
}

function cancelPendingSessionWrites(runtimeKey: string): void {
  for (const [key, pending] of pendingSessionWrites) {
    if (pending.runtimeKey === runtimeKey) pendingSessionWrites.delete(key)
  }
  if (pendingSessionWrites.size === 0 && pendingSessionWriteTimer !== undefined) {
    clearTimeout(pendingSessionWriteTimer)
    pendingSessionWriteTimer = undefined
  }
}

subscribeRuntimeEndpointWillChange(({ previousRuntimeKey }) => cancelPendingSessionWrites(previousRuntimeKey))

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingSessionWrites, { capture: true })
  window.addEventListener("beforeunload", flushPendingSessionWrites, { capture: true })
  // Desktop quits through app.exit(), which runs no unload handlers; the shell
  // dispatches this first so throttled writes are not lost.
  window.addEventListener("openchamber:flush-persisted-state", flushPendingSessionWrites)
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPendingSessionWrites()
    })
    document.addEventListener("freeze", flushPendingSessionWrites)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PersistedDirCache = {
  vcs: Vcs | undefined
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  sessions: Session[] | undefined
}

/** Read all cached metadata for a directory */
/**
 * The fields the stores dereference before bootstrap replaces a cached list.
 * localStorage is shared by every OpenChamber build that ran on this origin,
 * so a record written by another version is data, not a `Session`: a record
 * missing any of these is dropped instead of crashing the first render.
 */
const cachedSessionSchema = z.looseObject({
  id: z.string().min(1),
  directory: z.string(),
  projectID: z.string(),
  title: z.string(),
  time: z.looseObject({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
})

function parseCachedSessions(records: readonly unknown[]): Session[] {
  return records.flatMap((record) => {
    const parsed = cachedSessionSchema.safeParse(record)
    // SAFETY: the parsed record carries every field read before bootstrap and
    // keeps its remaining keys, which is all a stale-while-revalidate seed
    // needs. Persisted records omit usage and permissions (`PersistedSession`);
    // the authoritative list replaces every seeded record before they matter.
    return parsed.success ? [parsed.data as Session] : []
  })
}

function readCachedSessions(directory: string): Session[] | undefined {
  const cached = readCache<unknown>(directory, "sessions")
  if (!Array.isArray(cached)) return undefined
  return parseCachedSessions(cached)
}

export function readDirCache(directory: string): PersistedDirCache {
  return {
    vcs: readCache<Vcs>(directory, "vcs"),
    projectMeta: readCache<ProjectMeta>(directory, "projectMeta"),
    icon: readCache<string>(directory, "icon"),
    sessions: readCachedSessions(directory),
  }
}

/**
 * Write a capped slice of the directory session list to cache so the sidebar
 * can paint chats instantly on cold start. Refreshed by bootstrap loadSessions.
 */
export function persistSessions(directory: string, sessions: Session[] | undefined): void {
  const key = cacheKey(directory, "sessions")
  if (!sessions) {
    pendingSessionWrites.delete(key)
    writeCache(directory, "sessions", undefined)
    return
  }
  if (sessions.length === 0) {
    pendingSessionWrites.delete(key)
    writeSessionCache(key, legacyCacheKey(directory, "sessions"), sessions)
    return
  }
  scheduleSessionCacheWrite(directory, sessions)
}

export function readManagedChatSessions(expectedRuntimeKey = getRuntimeKey()): Session[] {
  if (isVSCodeRuntime()) return []
  if (expectedRuntimeKey !== getRuntimeKey()) return []
  return readDirCache(MANAGED_CHATS_CACHE_SCOPE).sessions?.filter((session) => (
    isChatDirectoryPath(session.directory)
  )) ?? []
}

export function persistManagedChatSessions(sessions: Session[]): void {
  if (isVSCodeRuntime()) return
  persistSessions(MANAGED_CHATS_CACHE_SCOPE, sessions.filter((session) => (
    isChatDirectoryPath(session.directory)
  )))
}

// ---------------------------------------------------------------------------
// Global active-session snapshot
// ---------------------------------------------------------------------------

function globalSnapshotKey(runtimeKey: string): string {
  return `oc.global-sessions.v${GLOBAL_SNAPSHOT_VERSION}.${hashCode(runtimeKey)}`
}

const globalSnapshotSchema = z.object({
  version: z.literal(GLOBAL_SNAPSHOT_VERSION),
  runtimeKey: z.string(),
  sessions: z.array(z.unknown()),
})

/**
 * Active sessions outside the managed chats root. Chats have their own
 * snapshot, which is classified against the server-resolved chats root.
 */
function isGlobalSnapshotSession(session: Session): boolean {
  return !session.time?.archived && !isChatDirectoryPath(session.directory)
}

function writeGlobalSessionSnapshot(key: string, runtimeKey: string, sessions: Session[]): void {
  const eligible = sessions.filter(isGlobalSnapshotSession)
  let removedStale = false
  for (const limit of GLOBAL_SNAPSHOT_LIMITS) {
    const serialized = JSON.stringify({
      version: GLOBAL_SNAPSHOT_VERSION,
      runtimeKey,
      sessions: selectRecentSessionsWithAncestors(eligible, limit).map(toPersistedSession),
    })
    countSyncPersistenceSerialization(serialized)
    if (serialized.length > GLOBAL_SNAPSHOT_MAX_CHARS) continue
    if (tryWriteSerialized(key, serialized)) return
    if (removedStale) continue
    // Quota: drop the stale snapshot so it does not block a smaller one.
    removedStale = true
    try {
      localStorage.removeItem(key)
    } catch {
      return
    }
  }
  // Nothing fits: no seed beats one describing an older list.
  try {
    localStorage.removeItem(key)
  } catch {
    // Unwritable storage keeps nothing new either way.
  }
}

/**
 * The persisted global snapshot for the active runtime, a startup seed and
 * never proof that a session exists. Missing, corrupt, or foreign data reads
 * as no seed; corrupt data is removed.
 */
export function readGlobalSessionSnapshot(): Session[] {
  if (isVSCodeRuntime()) return []
  const runtimeKey = getRuntimeKey() || "local"
  const key = globalSnapshotKey(runtimeKey)
  const pending = pendingSessionWrites.get(key)
  if (pending) {
    return selectRecentSessionsWithAncestors(pending.sessions.filter(isGlobalSnapshotSession), GLOBAL_SNAPSHOT_LIMITS[0])
  }
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return []
  }
  if (!raw) return []
  let envelope: z.infer<typeof globalSnapshotSchema> | undefined
  try {
    envelope = globalSnapshotSchema.safeParse(JSON.parse(raw)).data
  } catch {
    envelope = undefined
  }
  if (!envelope || envelope.runtimeKey !== runtimeKey) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Unreadable storage: the next write replaces the value.
    }
    return []
  }
  return parseCachedSessions(envelope.sessions).filter((session) => !session.time.archived)
}

/**
 * Persist the most recent active sessions (with their ancestors) for the next
 * cold start. Throttled with the directory snapshots; VS Code keeps none,
 * since its sidebar covers the open workspace, which its directory snapshot
 * already seeds.
 */
export function persistGlobalSessionSnapshot(sessions: Session[]): void {
  if (isVSCodeRuntime()) return
  const runtimeKey = getRuntimeKey() || "local"
  const key = globalSnapshotKey(runtimeKey)
  scheduleSessionWrite({ runtimeKey, key, sessions, write: () => writeGlobalSessionSnapshot(key, runtimeKey, sessions) })
}

/** Write vcs info to cache */
export function persistVcs(directory: string, vcs: Vcs | undefined): void {
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
