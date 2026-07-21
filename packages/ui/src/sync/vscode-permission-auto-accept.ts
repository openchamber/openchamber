import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { getAllSyncSessionMap, getSyncChildStores } from "./sync-refs"
import * as sessionActions from "./session-actions"

const RETRY_DELAYS_MS = [0, 250, 1000]

type Dependencies = {
  getPolicy: () => { default: boolean; sessions: Record<string, boolean> }
  getSessions: () => ReadonlyMap<string, Session>
  getSession: (sessionId: string, directory?: string) => Promise<Session>
  getKnownDirectories?: (directory?: string) => string[]
  listPendingPermissions: (directory?: string) => Promise<PermissionRequest[]>
  getPermissionState: (sessionId: string, requestId: string) => Promise<"ok" | "resolved" | "unknown">
  reply: (sessionId: string, requestId: string) => Promise<void>
  wait: (delayMs: number) => Promise<void>
}

const normalizeDirectory = (value?: string | null): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) return undefined
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
    .replace(/^\/([a-z]):\//, (_, letter: string) => `/${letter.toUpperCase()}:/`)
  if (normalized === "/") {
    return "/"
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

const uniqueDirectories = (directories: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const directory of directories) {
    const normalized = normalizeDirectory(directory)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

const getVSCodeWorkspaceDirectories = (): string[] => {
  if (typeof window === "undefined") return []
  const config = (window as unknown as {
    __VSCODE_CONFIG__?: {
      workspaceFolder?: unknown
      workspaceFolders?: unknown
    }
  }).__VSCODE_CONFIG__
  const workspaceFolders = Array.isArray(config?.workspaceFolders)
    ? config.workspaceFolders
        .map((entry) => {
          const candidate = entry as { path?: unknown }
          return typeof candidate.path === "string" ? candidate.path : undefined
        })
    : []
  if (workspaceFolders.length > 0) {
    return uniqueDirectories(workspaceFolders)
  }
  return uniqueDirectories([
    typeof config?.workspaceFolder === "string" ? config.workspaceFolder : undefined,
  ])
}

const getLiveSyncDirectories = (): string[] => {
  try {
    return uniqueDirectories(Array.from(getSyncChildStores().children.keys()))
  } catch {
    return []
  }
}

const isValidLineageSession = (sessionId: string, value: unknown): value is Session => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const id = typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id.trim() : ''
  return id === sessionId
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
    let resolvedLineage = false

    while (current && !seen.has(current)) {
      if (Object.prototype.hasOwnProperty.call(policy.sessions, current)) return policy.sessions[current] === true
      seen.add(current)

      const syncedHasSession = syncedSessions.has(current)
      const fetchedHasSession = fetchedSessions.has(current)
      let session: Session | undefined = syncedHasSession
        ? syncedSessions.get(current)
        : fetchedHasSession
          ? fetchedSessions.get(current)
          : undefined
      if ((syncedHasSession || fetchedHasSession) && !isValidLineageSession(current, session)) {
        return false
      }
      if (!session) {
        try {
          session = await dependencies.getSession(current, currentDirectory)
          if (!isValidLineageSession(current, session)) {
            return false
          }
          fetchedSessions.set(session.id, session)
        } catch {
          return false
        }
      }
      current = session.parentID
      currentDirectory = session.directory || currentDirectory
    }
    if (!current) {
      resolvedLineage = true
    }
    return resolvedLineage ? policy.default === true : false
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
    const directories = directory
      ? uniqueDirectories([directory])
      : uniqueDirectories(dependencies.getKnownDirectories?.() ?? [])
    const key = directories.join("\n") || "all"
    const existing = reconcileInFlight.get(key)
    if (existing) return existing

    const task = Promise.all((directories.length > 0 ? directories : [undefined]).map(async (knownDirectory) => {
      const permissions = await dependencies.listPendingPermissions(knownDirectory)
      await Promise.all(permissions.map((permission) => processPermission(permission, knownDirectory)))
    }))
      .then(() => undefined)
      .finally(() => reconcileInFlight.delete(key))

    reconcileInFlight.set(key, task)
    return task
  }

  return { processPermission, reconcilePending }
}

const runtime = createVSCodePermissionAutoAcceptRuntime({
  getPolicy: () => ({
    default: usePermissionStore.getState().defaultEnabled,
    sessions: usePermissionStore.getState().autoAccept,
  }),
  getSessions: getAllSyncSessionMap,
  getSession: (sessionId, directory) => opencodeClient.getSession(sessionId, directory),
  getKnownDirectories: (directory) => uniqueDirectories([
    directory,
    opencodeClient.getDirectory(),
    ...getLiveSyncDirectories(),
    ...getVSCodeWorkspaceDirectories(),
  ]),
  listPendingPermissions: (directory) => opencodeClient.listPendingPermissions({ directories: [directory] }),
  getPermissionState: async (sessionId, requestId) => (await opencodeClient.fetchPermission(sessionId, requestId)).state,
  reply: (sessionId, requestId) => sessionActions.respondToPermission(sessionId, requestId, "once"),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
})

export const processVSCodePermissionAutoAccept = runtime.processPermission
export const reconcileVSCodePendingPermissions = runtime.reconcilePending
