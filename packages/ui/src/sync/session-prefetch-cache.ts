/**
 * Session prefetch TTL cache — prevents redundant session fetches
 * within a short window. Port of OpenCode's session-prefetch.ts.
 *
 * Tracks: last fetch time, pagination cursor, completeness.
 * Version counter invalidates stale inflight requests after eviction.
 */

const SESSION_PREFETCH_TTL = 15_000

type Meta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
}

const compositeKey = (directory: string, sessionID: string) =>
  `${directory}\n${sessionID}`

const cache = new Map<string, Meta>()
const inflight = new Map<string, Promise<Meta | undefined>>()
const rev = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

const version = (id: string) => rev.get(id) ?? 0

const notify = (id: string) => {
  const callbacks = listeners.get(id)
  if (!callbacks) return
  callbacks.forEach((callback) => callback())
}

/** Check if a prefetch/sync can be skipped (recently fetched). */
export function shouldSkipSessionPrefetch(input: {
  hasMessages: boolean
  info?: Meta
  pageSize: number
  now?: number
}): boolean {
  if (!input.hasMessages) {
    return false
  }

  const info = input.info
  if (!info) return true
  if (info.complete) return true
  if (info.limit > input.pageSize) return true
  if (info.limit < input.pageSize) return false
  return (input.now ?? Date.now()) - info.at < SESSION_PREFETCH_TTL
}

export function getSessionPrefetch(directory: string, sessionID: string): Meta | undefined {
  return cache.get(compositeKey(directory, sessionID))
}

export function subscribeSessionPrefetch(directory: string, sessionID: string, callback: () => void) {
  if (!sessionID) return () => undefined
  const id = compositeKey(directory, sessionID)
  let callbacks = listeners.get(id)
  if (!callbacks) {
    callbacks = new Set()
    listeners.set(id, callbacks)
  }
  callbacks.add(callback)
  return () => {
    callbacks?.delete(callback)
    if (callbacks?.size === 0) listeners.delete(id)
  }
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
}) {
  const id = compositeKey(input.directory, input.sessionID)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
  notify(id)
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(directory, sessionID)
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
    notify(id)
  }
}
