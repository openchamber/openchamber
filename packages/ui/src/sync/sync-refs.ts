
import type { OpenCodeClient } from "@opencode/client"
import type { Config } from "@/lib/opencode/model"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import type { State } from "./types"

let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null
const configListeners = new Set<(directory: string, config: Config) => void>()
let cachedSessionManager: ChildStoreManager | null = null
let cachedSessionSlices = new Map<string, State["session"]>()
let cachedSessionsById = new Map<string, State["session"][number]>()
let cachedSessionDirectoryById = new Map<string, string>()

export function setSyncRefs(
  _sdk: OpenCodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  _childStores = childStores
  if (cachedSessionManager !== childStores) {
    cachedSessionManager = null
    cachedSessionSlices = new Map()
    cachedSessionsById = new Map()
    cachedSessionDirectoryById = new Map()
  }
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
}

export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  return stores.getState(dir)
}

export function getSyncConfig(directory?: string): Config | undefined {
  const config = getDirectoryState(directory)?.config
  return config && Object.keys(config).length > 0 ? config : undefined
}

export function subscribeToSyncConfigChanges(listener: (directory: string, config: Config) => void): () => void {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}

export function emitSyncConfigChanged(directory: string, config: Config): void {
  if (!directory) return
  for (const listener of configListeners) {
    listener(directory, config)
  }
}

export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

export function getSyncSessionSlices(): Array<readonly [string, State["session"]]> {
  const stores = _childStores
  if (!stores) return []
  return Array.from(stores.children, ([directory, store]) => [directory, store.getState().session] as const)
}

export function getAllSyncSessions() {
  return Array.from(getAllSyncSessionMap().values())
}

export function getAllSyncSessionMap(): ReadonlyMap<string, State["session"][number]> {
  const stores = _childStores
  if (!stores) return cachedSessionsById

  let changed = cachedSessionManager !== stores || cachedSessionSlices.size !== stores.children.size
  for (const [directory, store] of stores.children) {
    if (cachedSessionSlices.get(directory) !== store.getState().session) {
      changed = true
      break
    }
  }
  if (!changed) return cachedSessionsById

  const nextSlices = new Map<string, State["session"]>()
  const nextSessionsById = new Map<string, State["session"][number]>()
  const nextDirectoriesById = new Map<string, string>()
  for (const [directory, store] of stores.children) {
    const sessions = store.getState().session
    nextSlices.set(directory, sessions)
    for (const session of sessions) {
      if (!session?.id) continue
      nextSessionsById.set(session.id, session)
      nextDirectoriesById.set(session.id, directory)
    }
  }
  cachedSessionManager = stores
  cachedSessionSlices = nextSlices
  cachedSessionsById = nextSessionsById
  cachedSessionDirectoryById = nextDirectoriesById
  return cachedSessionsById
}

export function getSyncSessionDirectory(sessionId: string): string | null {
  if (!sessionId) return null
  getAllSyncSessionMap()
  return cachedSessionDirectoryById.get(sessionId) ?? null
}

export function getSyncMessages(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.message[sessionId] ?? []
}

export function getSyncSessionMaterializationStatus(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  if (!state) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  return getSessionMaterializationStatus(state, sessionId)
}

export function getSyncParts(messageId: string, directory?: string) {
  return getDirectoryState(directory)?.part[messageId] ?? []
}

export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}
