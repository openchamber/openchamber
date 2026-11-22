
const FLAG_KEY = "openchamber:sync:debug"

let _enabled: boolean | undefined

function isSyncDebugEnabled(): boolean {
  if (_enabled !== undefined) return _enabled
  try {
    _enabled = typeof localStorage !== "undefined" && localStorage.getItem(FLAG_KEY) === "1"
  } catch {
    _enabled = false
  }
  return _enabled
}
type SyncDebugCategory = "pipeline" | "reducer" | "dispatch" | "recovery"

function log(cat: SyncDebugCategory, ...args: unknown[]): void {
  if (!isSyncDebugEnabled()) return
  const tag = `%c[sync:${cat}]`
  const style = "color: #888"
  console.log(tag, style, ...args)
}

export const syncDebug = {
  pipeline: {
    coalesced: (eventType: string, coalesceKey: string) =>
      log("pipeline", "coalesced", eventType, coalesceKey),

    flush: (count: number) =>
      log("pipeline", "flush", `${count} events`),

    staleTurnBoundary: (eventType: string, seq: number) =>
      log("pipeline", "stale turn boundary dropped", eventType, seq),
  },

  reducer: {
    messageUpdatedUnchanged: (sessionID: string, messageID: string, role: string, finish: unknown, completed: unknown) =>
      log("reducer", "message.updated UNCHANGED (skipped)", { sessionID, messageID, role, finish, completed }),

    partUpdatedNoExistingParts: (messageID: string, partID: string, partType: string) =>
      log("reducer", "message.part.updated NO EXISTING PARTS", { messageID, partID, partType }),

    partDeltaNoParts: (messageID: string, partID: string) =>
      log("reducer", "message.part.delta DROPPED (no parts array)", { messageID, partID }),

    partDeltaNotFound: (messageID: string, partID: string) =>
      log("reducer", "message.part.delta DROPPED (partID not found)", { messageID, partID }),

    partSkipped: (messageID: string, partID: string, partType: string) =>
      log("reducer", "message.part.updated SKIPPED (type filtered)", { messageID, partID, partType }),
  },

  dispatch: {
    eventNoChange: (eventType: string, sessionID?: string, messageID?: string) =>
      log("dispatch", "event → no change", { eventType, sessionID, messageID }),

    eventApplied: (eventType: string, sessionID?: string, messageID?: string) =>
      log("dispatch", "event → applied", { eventType, sessionID, messageID }),
  },

  recovery: {
    materializing: (details: { reason: string; directory: string; sessionID: string; messageID?: string; partID?: string }) =>
      log("recovery", "materializing session", details),
  },
} as const
