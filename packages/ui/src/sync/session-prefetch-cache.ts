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

const compositeKey = (directory: string, sessionID: string) =>
  `${getRuntimeKey()}\n${directory}\n${sessionID}`

const cache = new Map<string, Meta>()

export function getSessionPrefetch(directory: string, sessionID: string): Meta | undefined {
  return cache.get(compositeKey(directory, sessionID))
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
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(directory, sessionID)
    cache.delete(id)
  }
}
