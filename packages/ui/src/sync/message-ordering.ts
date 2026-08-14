type ChronologicalMessage = {
  id: string
  time: { created: number }
}

/**
 * Match OpenCode's chronological message order: creation time first, then id
 * as a deterministic tie-breaker for messages created in the same millisecond.
 *
 * Message ids cannot be used as the primary key because their 48-bit encoded
 * clock wraps every 2^36 milliseconds.
 */
export const compareMessages = (left: ChronologicalMessage, right: ChronologicalMessage) => {
  if (left.time.created !== right.time.created) return left.time.created - right.time.created
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
