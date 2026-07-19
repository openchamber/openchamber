/**
 * Runtime-scoped pagination metadata shared with the session message loader.
 */

import { getRuntimeKey } from "@/lib/runtime-switch"

type Meta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
}

const MAX_PREFETCH_ENTRIES = 200
const compositeKey = (runtimeKey: string, directory: string, sessionID: string) =>
  `${runtimeKey}\n${directory}\n${sessionID}`

const cache = new Map<string, Meta>()

export function getSessionPrefetch(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): Meta | undefined {
  const id = compositeKey(runtimeKey, directory, sessionID)
  const value = cache.get(id)
  if (value) {
    cache.delete(id)
    cache.set(id, value)
  }
  return value
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
  runtimeKey?: string
}) {
  const id = compositeKey(input.runtimeKey ?? getRuntimeKey(), input.directory, input.sessionID)
  cache.delete(id)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
  while (cache.size > MAX_PREFETCH_ENTRIES) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>, runtimeKey = getRuntimeKey()) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(runtimeKey, directory, sessionID)
    cache.delete(id)
  }
}

export function clearDirectorySessionPrefetch(directory: string, runtimeKey = getRuntimeKey()) {
  const prefix = `${runtimeKey}\n${directory}\n`
  for (const id of cache.keys()) {
    if (id.startsWith(prefix)) cache.delete(id)
  }
}

export function clearRuntimeSessionPrefetch(runtimeKey: string) {
  const prefix = `${runtimeKey}\n`
  for (const id of cache.keys()) {
    if (id.startsWith(prefix)) cache.delete(id)
  }
}
