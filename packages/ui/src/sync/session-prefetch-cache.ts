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

export function getSessionPrefetchPromise(directory: string, sessionID: string) {
  return inflight.get(compositeKey(directory, sessionID))
}

export function isSessionPrefetchCurrent(directory: string, sessionID: string, value: number) {
  return version(compositeKey(directory, sessionID)) === value
}

/** Run a prefetch task with inflight dedup + version tracking. */
export function runSessionPrefetch(input: {
  directory: string
  sessionID: string
  task: (value: number) => Promise<Meta | undefined>
}) {
  const id = compositeKey(input.directory, input.sessionID)
  const pending = inflight.get(id)
  if (pending) return pending

  const value = version(id)

  const promise = input.task(value).finally(() => {
    if (inflight.get(id) === promise) inflight.delete(id)
  })

  inflight.set(id, promise)
  return promise
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

/** Invalidate all cache entries for a directory. */
export function clearSessionPrefetchDirectory(directory: string) {
  const prefix = `${directory}\n`
  const keys = new Set([...cache.keys(), ...inflight.keys()])
  for (const id of keys) {
    if (!id.startsWith(prefix)) continue
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
    notify(id)
  }
}
