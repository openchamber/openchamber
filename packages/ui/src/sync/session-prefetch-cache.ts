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

const version = (id: string) => rev.get(id) ?? 0

/** Check if a prefetch/sync can be skipped (recently fetched). */
export function shouldSkipSessionPrefetch(input: {
  hasMessages: boolean
  info?: Meta
  pageSize: number
  now?: number
}): boolean {
  if (input.hasMessages) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.limit > input.pageSize) return true
  } else {
    if (!input.info) return false
  }
  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

export function getSessionPrefetch(directory: string, sessionID: string): Meta | undefined {
  return cache.get(compositeKey(directory, sessionID))
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
  cache.set(compositeKey(input.directory, input.sessionID), {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(directory, sessionID)
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
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
  }
}
