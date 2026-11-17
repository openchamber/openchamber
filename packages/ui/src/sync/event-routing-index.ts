import { syncEventMessageID, syncEventSessionID, type SyncEvent } from "@/lib/opencode/events"
import type { Message } from "@/lib/opencode/model"
import { ChildStoreManager } from "./child-store"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import type { State } from "./types"
import { EMPTY_MESSAGES } from "./sync-empty-values"
import { type DirectoryEventBatch, getDirectoryEventState } from "./directory-event-batch"
import { getActiveSession } from "./viewed-sessions"

export type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

export const createEventRoutingIndex = (): EventRoutingIndex => ({
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
})

export const normalizeEventDirectory = (rawDirectory: string): string => {
  if (!rawDirectory || rawDirectory === "global") {
    return rawDirectory
  }
  const normalized = rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

export const setIndexedSessionDirectory = (routingIndex: EventRoutingIndex, sessionID: string, directory: string) => {
  if (!sessionID || !directory || directory === "global") {
    return
  }
  routingIndex.sessionDirectoryById.set(sessionID, directory)
}

export const setIndexedSessionMessages = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  directory: string,
  messages: Message[],
) => {
  if (!sessionID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)

  const previous = routingIndex.sessionMessageIdsById.get(sessionID)
  const next = new Set<string>()

  for (const message of messages) {
    if (!message?.id) {
      continue
    }
    next.add(message.id)
    routingIndex.messageSessionById.set(message.id, sessionID)
  }

  if (previous) {
    for (const previousMessageID of previous) {
      if (!next.has(previousMessageID)) {
        routingIndex.messageSessionById.delete(previousMessageID)
      }
    }
  }

  routingIndex.sessionMessageIdsById.set(sessionID, next)
}

const setIndexedMessage = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  messageID: string,
  directory: string,
) => {
  if (!sessionID || !messageID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)
  routingIndex.messageSessionById.set(messageID, sessionID)

  const existing = routingIndex.sessionMessageIdsById.get(sessionID)
  if (existing) {
    existing.add(messageID)
  } else {
    routingIndex.sessionMessageIdsById.set(sessionID, new Set([messageID]))
  }
}

const removeIndexedMessage = (
  routingIndex: EventRoutingIndex,
  messageID: string,
  sessionHint?: string | null,
) => {
  if (!messageID) {
    return
  }

  const sessionID = sessionHint ?? routingIndex.messageSessionById.get(messageID)
  routingIndex.messageSessionById.delete(messageID)

  if (!sessionID) {
    return
  }

  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (!messageIds) {
    return
  }

  messageIds.delete(messageID)
  if (messageIds.size === 0) {
    routingIndex.sessionMessageIdsById.delete(sessionID)
  }
}

const removeIndexedSession = (routingIndex: EventRoutingIndex, sessionID: string) => {
  if (!sessionID) {
    return
  }

  routingIndex.sessionDirectoryById.delete(sessionID)
  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (messageIds) {
    for (const messageID of messageIds) {
      routingIndex.messageSessionById.delete(messageID)
    }
  }
  routingIndex.sessionMessageIdsById.delete(sessionID)
}

export const ingestDirectoryStateIntoRoutingIndex = (
  routingIndex: EventRoutingIndex,
  directory: string,
  state: State,
) => {
  const nextSessionIds = new Set<string>()

  for (const session of state.session) {
    if (!session?.id) {
      continue
    }
    nextSessionIds.add(session.id)
    setIndexedSessionDirectory(routingIndex, session.id, directory)
  }

  for (const sessionID of Object.keys(state.message)) {
    nextSessionIds.add(sessionID)
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
    setIndexedSessionMessages(routingIndex, sessionID, directory, state.message[sessionID] ?? EMPTY_MESSAGES)
  }

  for (const [indexedSessionID, indexedDirectory] of routingIndex.sessionDirectoryById) {
    if (indexedDirectory !== directory) {
      continue
    }
    if (!nextSessionIds.has(indexedSessionID)) {
      removeIndexedSession(routingIndex, indexedSessionID)
    }
  }
}

export const findSessionInChildStores = (
  sessionID: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  batch?: DirectoryEventBatch,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = getDirectoryEventState(store, batch)
    if (
      state.session.some((s) => s.id === sessionID)
      || Object.prototype.hasOwnProperty.call(state.message, sessionID)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
    ) {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
      return dir
    }
  }
  return null
}

const childStoreHasSessionState = (
  childStores: ChildStoreManager,
  directory: string,
  sessionID: string,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  const state = getDirectoryEventState(store, batch)
  return state.session.some((session) => session.id === sessionID)
    || Object.prototype.hasOwnProperty.call(state.message, sessionID)
    || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
}

const childStoreHasMessagePartState = (
  childStores: ChildStoreManager,
  directory: string,
  messageID: string,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  return Object.prototype.hasOwnProperty.call(getDirectoryEventState(store, batch).part, messageID)
}

const getActiveDirectoryFallback = (
  childStores: ChildStoreManager,
  sessionID?: string | null,
): string | null => {
  const { directory: _activeDirectory, sessionId: _activeSession } = getActiveSession()
  if (!_activeDirectory || !_activeSession) return null
  if (sessionID && sessionID !== _activeSession) return null
  return childStores.getChild(_activeDirectory) ? _activeDirectory : null
}

export const resolveCachedSessionDirectory = (sessionID: string): string | null => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionID)
  return session ? resolveGlobalSessionDirectory(session) : null
}

const isBlockingRequestEvent = (payload: SyncEvent): boolean => (
  payload.type === "permission.asked"
  || payload.type === "permission.replied"
  || payload.type === "form.created"
  || payload.type === "form.settled"
)

export const directorySessionMovedTo = (state: State, directory: string, sessionID: string): string | null => {
  if (state.sessionDeletedRevision?.[sessionID] === undefined) return null
  if (state.session.some((session) => session.id === sessionID)) return null
  const ownDirectory = resolveCachedSessionDirectory(sessionID)
  if (ownDirectory === null) return null
  return normalizeEventDirectory(ownDirectory) === normalizeEventDirectory(directory) ? null : ownDirectory
}

export const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  const addressedSessionID = syncEventSessionID(payload)
  const sessionID = addressedSessionID === LOCATION_SCOPED_FORM_SESSION_ID ? undefined : addressedSessionID
  if (sessionID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID, batch)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
    }

    if (isBlockingRequestEvent(payload) && (!normalizedDirectory || normalizedDirectory === "global")) {
      const ownDirectory = resolveCachedSessionDirectory(sessionID)
      if (ownDirectory && childStores.getChild(ownDirectory)) {
        setIndexedSessionDirectory(routingIndex, sessionID, ownDirectory)
        return ownDirectory
      }
    }

    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    const found = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
    if (found) {
      return found
    }

    const cachedDirectory = resolveCachedSessionDirectory(sessionID)
    if (cachedDirectory) {
      return cachedDirectory
    }

    const activeDirectory = getActiveDirectoryFallback(childStores, sessionID)
    if (activeDirectory) {
      return activeDirectory
    }
  }

  const messageID = syncEventMessageID(payload)
  if (messageID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasMessagePartState(childStores, normalizedDirectory, messageID, batch)) {
      return normalizedDirectory
    }

    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory && childStores.getChild(indexedDirectory)) {
        return indexedDirectory
      }
    }

    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(getDirectoryEventState(store, batch).part, messageID)) {
        return dir
      }
    }

    const activeDirectory = getActiveDirectoryFallback(childStores)
    if (activeDirectory) {
      return activeDirectory
    }
  }

  if (
    (addressedSessionID || messageID)
    && (!normalizedDirectory || normalizedDirectory === "global")
    && childStores.children.size === 1
  ) {
    const onlyDirectory = childStores.children.keys().next().value
    if (typeof onlyDirectory === "string" && onlyDirectory.length > 0) {
      return onlyDirectory
    }
  }

  return normalizedDirectory
}

export const resolveMaterializationSessionID = (
  materializationSessionID: string | undefined,
  messageID: string | undefined,
  resolvedDirectory: string,
  routingIndex: EventRoutingIndex,
): string | undefined => {
  if (materializationSessionID) return materializationSessionID
  if (messageID) {
    const indexedSessionID = routingIndex.messageSessionById.get(messageID)
    if (indexedSessionID) return indexedSessionID
  }
  const { directory: _activeDirectory, sessionId: _activeSession } = getActiveSession()
  if (resolvedDirectory && resolvedDirectory === _activeDirectory && _activeSession) {
    return _activeSession
  }
  return undefined
}

export const updateRoutingIndexFromEvent = (
  routingIndex: EventRoutingIndex,
  directory: string,
  payload: SyncEvent,
) => {
  if (!directory || directory === "global") {
    return
  }

  const sessionID = syncEventSessionID(payload)
  if (sessionID && sessionID !== LOCATION_SCOPED_FORM_SESSION_ID) {
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
  }

  switch (payload.type) {
    case "session.created":
      setIndexedSessionDirectory(routingIndex, payload.properties.info.id, directory)
      return

    case "session.deleted":
      removeIndexedSession(routingIndex, payload.properties.sessionID)
      return

    case "message.updated": {
      const { info } = payload.properties
      setIndexedMessage(routingIndex, info.sessionID, info.id, directory)
      return
    }

    case "message.removed": {
      const { sessionID, messageID } = payload.properties
      removeIndexedMessage(routingIndex, messageID, sessionID)
      return
    }

    case "message.part.updated": {
      const { part } = payload.properties
      setIndexedMessage(routingIndex, part.sessionID ?? payload.properties.sessionID, part.messageID, directory)
      return
    }

    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      setIndexedMessage(routingIndex, payload.properties.sessionID, payload.properties.messageID, directory)
      return

    default:
      return
  }
}
