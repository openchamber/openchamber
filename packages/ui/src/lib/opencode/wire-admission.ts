import type { OpenCodeEvent } from "@opencode/client"
import { z } from "zod"

export const wireEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  location: z.object({ directory: z.string() }).partial().optional(),
})

const TURN_BOUNDARY_TYPES: ReadonlySet<OpenCodeEvent["type"]> = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export type StaleWireEventCheck = (event: OpenCodeEvent) => boolean

export function createTurnBoundaryOrder(onStale?: (type: OpenCodeEvent["type"], seq: number) => void): StaleWireEventCheck {
  const newestBySession = new Map<string, number>()
  return (event) => {
    if (!("durable" in event)) return false
    const { aggregateID, seq } = event.durable
    if (!("sessionID" in event.data) || event.data.sessionID !== aggregateID) return false
    if (event.type === "session.deleted") {
      newestBySession.delete(aggregateID)
      return false
    }
    const newest = newestBySession.get(aggregateID)
    if (newest === undefined || seq > newest) {
      newestBySession.set(aggregateID, seq)
      return false
    }
    if (!TURN_BOUNDARY_TYPES.has(event.type)) return false
    onStale?.(event.type, seq)
    return true
  }
}
