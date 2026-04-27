/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager } from "./child-store"
import type { State } from "./types"
import {
  getOpenCodeCompatibleMessages,
  getOpenCodeCompatibleParts,
  getOpenCodeCompatibleSessions,
  toOpenCodeCompatibleSession,
} from "./compat"

let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null

export function setSyncRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  _sdk = sdk
  _childStores = childStores
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncSDK(): OpencodeClient {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

export function getSyncDirectory(): string {
  return _directory
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  return stores.getState(dir)
}

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  const state = getDirectoryState(directory)
  return state ? getOpenCodeCompatibleSessions(state) : []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  const stores = _childStores
  if (!stores) return []

  const deduped = new Map<string, ReturnType<typeof toOpenCodeCompatibleSession>>()
  for (const store of stores.children.values()) {
    for (const session of store.getState().session) {
      if (!session?.id) continue
      deduped.set(session.id, toOpenCodeCompatibleSession(session))
    }
  }
  return Array.from(deduped.values())
}

/** Read messages for a session from current directory's child store */
export function getSyncMessages(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  return state ? getOpenCodeCompatibleMessages(state, sessionId) : []
}

/** Read parts for a message from current directory's child store */
export function getSyncParts(messageId: string, directory?: string) {
  const state = getDirectoryState(directory)
  return state ? getOpenCodeCompatibleParts(state, messageId) : []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}

/** Read permissions for a session from current directory's child store */
export function getSyncPermissions(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.permission[sessionId] ?? []
}

/** Read questions for a session from current directory's child store */
export function getSyncQuestions(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.question[sessionId] ?? []
}
