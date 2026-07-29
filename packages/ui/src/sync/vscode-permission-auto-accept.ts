import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { getAllSyncSessionMap } from "./sync-refs"
import * as sessionActions from "./session-actions"

const RETRY_DELAYS_MS = [0, 250, 1000]

type Dependencies = {
  getPolicy: () => Record<string, boolean>
  getSessions: () => ReadonlyMap<string, Session>
  getSession: (sessionId: string, directory?: string) => Promise<Session>
  listPendingPermissions: (directory?: string) => Promise<PermissionRequest[]>
  getPermissionState: (sessionId: string, requestId: string) => Promise<"ok" | "resolved" | "unknown">
  reply: (sessionId: string, requestId: string) => Promise<void>
  wait: (delayMs: number) => Promise<void>
}

export function createVSCodePermissionAutoAcceptRuntime(dependencies: Dependencies) {
  const inFlight = new Map<string, Promise<boolean>>()
  const reconcileInFlight = new Map<string, Promise<void>>()
  const recentOutcomes = new Map<string, boolean>()

  const isEnabled = async (sessionId: string, directory?: string) => {
    const policy = dependencies.getPolicy()
    const syncedSessions = dependencies.getSessions()
    const fetchedSessions = new Map<string, Session>()
    const seen = new Set<string>()
    let current: string | undefined = sessionId
    let currentDirectory = directory

    while (current && !seen.has(current)) {
      if (Object.prototype.hasOwnProperty.call(policy, current)) return policy[current] === true
      seen.add(current)

      let session: Session | undefined = syncedSessions.get(current) ?? fetchedSessions.get(current)
      if (!session) {
        try {
          session = await dependencies.getSession(current, currentDirectory)
          fetchedSessions.set(session.id, session)
        } catch {
          return false
        }
      }
      current = session.parentID
      currentDirectory = session.directory || currentDirectory
    }
    return false
  }

  const processPermission = (permission: PermissionRequest, directory?: string) => {
    const recent = recentOutcomes.get(permission.id)
    if (recent !== undefined) return Promise.resolve(recent)
    const existing = inFlight.get(permission.id)
    if (existing) return existing

    const task = (async () => {
      if (!(await isEnabled(permission.sessionID, directory))) return false

      const permissionState = await dependencies.getPermissionState(permission.sessionID, permission.id)
      if (permissionState === "resolved") return true

      for (const delay of RETRY_DELAYS_MS) {
        if (delay > 0) await dependencies.wait(delay)
        try {
          await dependencies.reply(permission.sessionID, permission.id)
          return true
        } catch {
          // A failed reply stays visible after the bounded retries.
        }
      }
      return false
    })().then((accepted) => {
      if (accepted) {
        recentOutcomes.set(permission.id, true)
        setTimeout(() => recentOutcomes.delete(permission.id), 5000)
      }
      return accepted
    }).finally(() => inFlight.delete(permission.id))

    inFlight.set(permission.id, task)
    return task
  }

  const reconcilePending = (directory?: string) => {
    const key = directory?.trim() || "all"
    const existing = reconcileInFlight.get(key)
    if (existing) return existing

    const task = dependencies.listPendingPermissions(directory)
      .then(async (permissions) => {
        await Promise.all(permissions.map((permission) => processPermission(permission, directory)))
      })
      .finally(() => reconcileInFlight.delete(key))

    reconcileInFlight.set(key, task)
    return task
  }

  return { processPermission, reconcilePending }
}

const runtime = createVSCodePermissionAutoAcceptRuntime({
  getPolicy: () => usePermissionStore.getState().autoAccept,
  getSessions: getAllSyncSessionMap,
  getSession: (sessionId, directory) => opencodeClient.getSession(sessionId, directory),
  listPendingPermissions: (directory) => opencodeClient.listPendingPermissions({ directories: [directory] }),
  getPermissionState: async (sessionId, requestId) => (await opencodeClient.fetchPermission(sessionId, requestId)).state,
  reply: (sessionId, requestId) => sessionActions.respondToPermission(sessionId, requestId, "once"),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
})

export const processVSCodePermissionAutoAccept = runtime.processPermission
export const reconcileVSCodePendingPermissions = runtime.reconcilePending
