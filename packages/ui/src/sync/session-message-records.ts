import React, { useRef, useCallback } from "react"
import type { StoreApi } from "zustand"
import type { Message, Part } from "@/lib/opencode/model"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { subscribeDirectorySessionMessages, type DirectoryStore } from "./child-store"
import { countSyncPerformance } from "./performance-diagnostics"
import { Binary } from "./binary"
import { messagesBefore } from "./message-ordering"
import type { State } from "./types"
import { EMPTY_PARTS, EMPTY_MESSAGES } from "./sync-empty-values"
import { useDirectoryStore } from "./directory-sync-hooks"

type SessionMessageRecord = { info: Message; parts: Part[] }

const EMPTY_SESSION_MESSAGE_RECORDS: SessionMessageRecord[] = []

type SessionMessageRecordsSnapshot = {
  sessionID: string
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
  suspendPartUpdates: boolean
  suspendedPartUpdatesMessageID?: string
  list: SessionMessageRecord[]
  byId: Map<string, SessionMessageRecord>
}

const SESSION_MESSAGE_RECORDS_CACHE_MAX = 40

const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4

const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30

const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4

const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30

const sessionMessageRecordsCache = new WeakMap<StoreApi<DirectoryStore>, Map<string, SessionMessageRecordsSnapshot>>()

const getSessionMessageRecordsCacheKey = (
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): string => (
  `${sessionID}\u0000${suspendPartUpdates ? 1 : 0}\u0000${suspendedPartUpdatesMessageID ?? ""}`
)

const getSessionMessageRecordsCache = (store: StoreApi<DirectoryStore>): Map<string, SessionMessageRecordsSnapshot> => {
  let cache = sessionMessageRecordsCache.get(store)
  if (!cache) {
    cache = new Map()
    sessionMessageRecordsCache.set(store, cache)
  }
  return cache
}

const readCachedSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return undefined
  const key = getSessionMessageRecordsCacheKey(sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  const cached = cache.get(key)
  if (!cached) return undefined
  cache.delete(key)
  cache.set(key, cached)
  return cached
}

const rememberSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  snapshot: SessionMessageRecordsSnapshot,
): void => {
  if (!snapshot.sessionID) return
  const cache = getSessionMessageRecordsCache(store)
  const key = getSessionMessageRecordsCacheKey(
    snapshot.sessionID,
    snapshot.suspendPartUpdates,
    snapshot.suspendedPartUpdatesMessageID,
  )
  const constrainedMaxMessages = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
      : null
  if (constrainedMaxMessages !== null && snapshot.list.length > constrainedMaxMessages) {
    cache.delete(key)
    return
  }
  cache.delete(key)
  cache.set(key, snapshot)
  const max = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX
      : SESSION_MESSAGE_RECORDS_CACHE_MAX
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

export function dropCachedSessionMessageRecordsSnapshots(
  store: StoreApi<DirectoryStore>,
  sessionIDs: Iterable<string>,
): void {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const prefix = `${sessionID}\u0000`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key)
      }
    }
  }
}

type TaskToolPart = Extract<Part, { type: "tool" }>

const isTaskToolPart = (part: Part | undefined): part is TaskToolPart => (
  part?.type === "tool" && part.tool?.trim().toLowerCase() === "task"
)

const readTaskSessionId = (part: Part | undefined): string | undefined => {
  if (!isTaskToolPart(part)) return undefined
  const metadata = (part.state as { metadata?: unknown } | undefined)?.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const record = metadata as { sessionId?: unknown; sessionID?: unknown }
  const value = typeof record.sessionId === "string" ? record.sessionId : record.sessionID
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const hasTaskSessionIdentityChange = (previous: Part[], current: Part[] | undefined): boolean => {
  let previousTaskCount = 0
  for (const part of previous) {
    if (!isTaskToolPart(part)) continue
    previousTaskCount += 1
    const currentPart = current?.find((candidate) => candidate.id === part.id && isTaskToolPart(candidate))
    if (!currentPart || readTaskSessionId(part) !== readTaskSessionId(currentPart)) return true
  }

  let currentTaskCount = 0
  for (const part of current ?? EMPTY_PARTS) {
    if (isTaskToolPart(part)) currentTaskCount += 1
  }
  return previousTaskCount !== currentTaskCount
}

const snapshotPartsMatchState = (snapshot: SessionMessageRecordsSnapshot, state: State): boolean => {
  for (const record of snapshot.list) {
    if (snapshot.suspendPartUpdates) {
      const suspendedID = snapshot.suspendedPartUpdatesMessageID
      if (
        (!suspendedID || record.info.id === suspendedID)
        && !hasTaskSessionIdentityChange(record.parts, state.part[record.info.id])
      ) {
        continue
      }
    }
    if ((state.part[record.info.id] ?? EMPTY_PARTS) !== record.parts) {
      return false
    }
  }

  return true
}

export const getSessionRevertMessageID = (sessions: State["session"], sessionID: string): string | undefined => {
  const result = Binary.search(sessions, sessionID, (session) => session.id)
  return result.found ? sessions[result.index]?.revert?.messageID : undefined
}

const getReusableSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  state: State,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cached = readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  if (!cached) return undefined
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const revertMessageID = getSessionRevertMessageID(state.session, sessionID)
  if (
    cached.sourceMessages === sourceMessages
    && cached.revertMessageID === revertMessageID
    && cached.suspendPartUpdates === suspendPartUpdates
    && cached.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && snapshotPartsMatchState(cached, state)
  ) {
    return cached
  }
  return undefined
}

function getVisibleMessagesForSession(state: State, sessionID: string, previous?: SessionMessageRecordsSnapshot): {
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
} {
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const revertMessageID = getSessionRevertMessageID(state.session, sessionID)

  if (
    previous
    && previous.sourceMessages === sourceMessages
    && previous.revertMessageID === revertMessageID
  ) {
    return {
      sourceMessages,
      visibleMessages: previous.visibleMessages,
      revertMessageID,
    }
  }

  return {
    sourceMessages,
    visibleMessages: messagesBefore(sourceMessages, revertMessageID),
    revertMessageID,
  }
}

export function buildSessionMessageRecordsSnapshot(
  state: State,
  sessionID: string,
  previous?: SessionMessageRecordsSnapshot,
  suspendPartUpdates = false,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const shouldSuspendParts = suspendPartUpdates
      && previousRecord
      && (!suspendedPartUpdatesMessageID || message.id === suspendedPartUpdatesMessageID)
      && !hasTaskSessionIdentityChange(previousRecord.parts, state.part[message.id])
    const parts = shouldSuspendParts
      ? previousRecord.parts
      : (state.part[message.id] ?? EMPTY_PARTS)

    const nextRecord = previousRecord && previousRecord.info === message && previousRecord.parts === parts
      ? previousRecord
      : { info: message, parts }

    nextById.set(message.id, nextRecord)
    return nextRecord
  })

  const unchanged = Boolean(previous)
    && previous?.visibleMessages === visibleMessages
    && previous.suspendPartUpdates === suspendPartUpdates
    && previous.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && previous.list.length === nextList.length
    && previous.list.every((record, index) => record === nextList[index])

  if (unchanged && previous) {
    return previous
  }

  return {
    sessionID,
    sourceMessages,
    visibleMessages,
    revertMessageID,
    suspendPartUpdates,
    suspendedPartUpdatesMessageID,
    list: nextList,
    byId: nextById,
  }
}

export function readSessionMessageRecordsSnapshot(
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  current: SessionMessageRecordsSnapshot,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot {
  const state = store.getState()
  const sameSession = current.sessionID === sessionID
  const suspensionChanged = sameSession && (
    current.suspendPartUpdates !== suspendPartUpdates
    || current.suspendedPartUpdatesMessageID !== suspendedPartUpdatesMessageID
  )
  const reusableSnapshot = suspensionChanged
    ? undefined
    : getReusableSessionMessageRecordsSnapshot(store, state, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  if (reusableSnapshot) return reusableSnapshot

  const previousSnapshot = sameSession
    ? current
    : readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  const nextSnapshot = buildSessionMessageRecordsSnapshot(
    state,
    sessionID,
    previousSnapshot,
    suspendPartUpdates,
    suspendedPartUpdatesMessageID,
  )
  rememberSessionMessageRecordsSnapshot(store, nextSnapshot)
  return nextSnapshot
}

export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { enabled?: boolean; suspendPartUpdates?: boolean; suspendPartUpdatesForMessageId?: string | null },
) {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<SessionMessageRecordsSnapshot>({
    sessionID,
    sourceMessages: EMPTY_MESSAGES,
    visibleMessages: EMPTY_MESSAGES,
    revertMessageID: undefined,
    suspendPartUpdates: Boolean(options?.suspendPartUpdates),
    suspendedPartUpdatesMessageID: options?.suspendPartUpdatesForMessageId ?? undefined,
    list: [],
    byId: new Map(),
  })

  const getSnapshot = useCallback(() => {
    if (!sessionID) {
      return EMPTY_SESSION_MESSAGE_RECORDS
    }
    if (options?.enabled === false) {
      return snapshotRef.current.sessionID === sessionID ? snapshotRef.current.list : EMPTY_SESSION_MESSAGE_RECORDS
    }

    snapshotRef.current = readSessionMessageRecordsSnapshot(
      store,
      sessionID,
      snapshotRef.current,
      Boolean(options?.suspendPartUpdates),
      options?.suspendPartUpdatesForMessageId ?? undefined,
    )
    return snapshotRef.current.list
  }, [options?.enabled, options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID || options?.enabled === false) return () => undefined
    const unsubscribeMessages = subscribeDirectorySessionMessages(store, sessionID, (change) => {
      const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
      const suspendedPartUpdatesMessageID = options?.suspendPartUpdatesForMessageId ?? undefined
      if (!change.messagesChanged && !change.reset && suspendPartUpdates && change.partMessageIDs.length > 0) {
        const state = store.getState()
        const snapshot = snapshotRef.current.sessionID === sessionID ? snapshotRef.current : undefined
        const allChangesSuspended = change.partMessageIDs.every((messageID) => {
          if (suspendedPartUpdatesMessageID && messageID !== suspendedPartUpdatesMessageID) return false
          const previousParts = snapshot?.byId.get(messageID)?.parts
          return Boolean(
            previousParts
            && !hasTaskSessionIdentityChange(previousParts, state.part[messageID]),
          )
        })
        if (allChangesSuspended) {
          countSyncPerformance("sessionMessageRecordNotificationSkips")
          return
        }
      }
      notify()
    })
    const unsubscribeSession = store.subscribe((state, previous) => {
      if (state.session === previous.session) return
      if (getSessionRevertMessageID(state.session, sessionID) !== getSessionRevertMessageID(previous.session, sessionID)) notify()
    })
    return () => {
      unsubscribeMessages()
      unsubscribeSession()
    }
  }, [options?.enabled, options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
