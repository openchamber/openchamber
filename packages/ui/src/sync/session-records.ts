import type { Session } from "@opencode-ai/sdk/v2"
import { Binary } from "./binary"

function areSessionsEqual(left: Session, right: Session): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function upsertSessionRecord(current: Session[], incoming: Session): Session[] {
  const result = Binary.search(current, incoming.id, (session) => session.id)
  if (!result.found) return [...current.slice(0, result.index), incoming, ...current.slice(result.index)]
  // Equivalent authoritative detail must retain sidebar session-list references.
  if (areSessionsEqual(current[result.index], incoming)) return current
  const next = [...current]
  next[result.index] = incoming
  return next
}
