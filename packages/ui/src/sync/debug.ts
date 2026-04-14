/**
 * Sync debug logging — gated behind localStorage flag.
 *
 * Enable in browser console:
 *   localStorage.setItem("openchamber:sync:debug", "1")
 *
 * Disable:
 *   localStorage.removeItem("openchamber:sync:debug")
 *
 * All checks are early-returns on the hot path — zero cost when disabled.
 */

const FLAG_KEY = "openchamber:sync:debug"

let _enabled: boolean | undefined

export function isSyncDebugEnabled(): boolean {
  if (_enabled !== undefined) return _enabled
  try {
    _enabled = typeof localStorage !== "undefined" && localStorage.getItem(FLAG_KEY) === "1"
  } catch {
    _enabled = false
  }
  return _enabled
}

/** Force-refresh the flag (call after user toggles localStorage). */
export function refreshSyncDebugFlag(): void {
  _enabled = undefined
}

type SyncDebugCategory = "pipeline" | "reducer" | "dispatch"

function log(cat: SyncDebugCategory, ...args: unknown[]): void {
  if (!isSyncDebugEnabled()) return
  const tag = `%c[sync:${cat}]`
  const style = "color: #888"
  console.log(tag, style, ...args)
}

export const syncDebug = {
  pipeline: {
    /** Event coalesced (replaced an earlier event in the queue). */
    coalesced: (eventType: string, coalesceKey: string) =>
      log("pipeline", "coalesced", eventType, coalesceKey),

    /** Flush batch dispatched. */
    flush: (count: number) =>
      log("pipeline", "flush", `${count} events`),
  },

  reducer: {
    /** message.updated skipped because role/finish/completed matched existing. */
    messageUpdatedUnchanged: (sessionID: string, messageID: string, role: string, finish: unknown, completed: unknown) =>
      log("reducer", "message.updated UNCHANGED (skipped)", { sessionID, messageID, role, finish, completed }),

    /** message.part.updated arrived but no parts array exists for this messageID. */
    partUpdatedNoExistingParts: (messageID: string, partID: string, partType: string) =>
      log("reducer", "message.part.updated NO EXISTING PARTS", { messageID, partID, partType }),

    /** message.part.delta arrived but parts array missing — silently dropped. */
    partDeltaNoParts: (messageID: string, partID: string) =>
      log("reducer", "message.part.delta DROPPED (no parts array)", { messageID, partID }),

    /** message.part.delta arrived but partID not found in parts array. */
    partDeltaNotFound: (messageID: string, partID: string) =>
      log("reducer", "message.part.delta DROPPED (partID not found)", { messageID, partID }),

    /** SKIP_PARTS filtered out a part. */
    partSkipped: (messageID: string, partID: string, partType: string) =>
      log("reducer", "message.part.updated SKIPPED (type filtered)", { messageID, partID, partType }),
  },

  dispatch: {
    /** Event dispatched to store but reducer returned false (no state change). */
    eventNoChange: (eventType: string, sessionID?: string, messageID?: string) =>
      log("dispatch", "event → no change", { eventType, sessionID, messageID }),

    /** Event applied to store successfully. */
    eventApplied: (eventType: string, sessionID?: string, messageID?: string) =>
      log("dispatch", "event → applied", { eventType, sessionID, messageID }),
  },
} as const