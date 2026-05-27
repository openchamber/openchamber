/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import type { State } from "./types"
import { useDirectoryStore as useDirStore } from "@/stores/useDirectoryStore"

let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null
const configListeners = new Set<(directory: string, config: Config) => void>()
let _cleanRoutingIndex: (() => void) | null = null

export function setSyncRefs(
  _sdk: OpencodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
  cleanRoutingIndex?: () => void,
) {
  _childStores = childStores
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
  if (cleanRoutingIndex) {
    _cleanRoutingIndex = cleanRoutingIndex
  }
}

export function cleanRoutingIndex() {
  _cleanRoutingIndex?.()
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  const serverId = useDirStore.getState().currentServerId
  return (
    stores.getStateByServer(serverId, dir) ??
    (stores.findChildByDirectory?.(dir)?.getState())
  )
}

/** Read resolved OpenCode config from a directory child store, if bootstrapped. */
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

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  const stores = _childStores
  if (!stores) return []

  const deduped = new Map<string, State["session"][number]>()
  for (const store of stores.getAllStores()) {
    for (const session of store.getState().session) {
      if (!session?.id) continue
      deduped.set(session.id, session)
    }
  }
  return Array.from(deduped.values())
}

/** Read messages for a session from current directory's child store */
export function getSyncMessages(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.message[sessionId] ?? []
}

/** Read renderability of a session snapshot from current directory's child store */
export function getSyncSessionMaterializationStatus(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  if (!state) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  return getSessionMaterializationStatus(state, sessionId)
}

/** Read parts for a message from current directory's child store */
export function getSyncParts(messageId: string, directory?: string) {
  return getDirectoryState(directory)?.part[messageId] ?? []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}
