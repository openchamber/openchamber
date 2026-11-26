import React, { useRef, useCallback } from "react"
import type { Message, Part } from "@/lib/opencode/model"
import { subscribeDirectorySessionMessages } from "./child-store"
import { countSyncPerformance } from "./performance-diagnostics"
import type { State } from "./types"
import { getSessionMaterializationStatus } from "./materialization"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type TranscriptPrompt, type UserMessageHistorySnapshot } from "./user-message-history"
import { useDirectoryStore, useDirectorySync } from "./directory-sync-hooks"
import { EMPTY_MESSAGES, EMPTY_PARTS } from "./sync-empty-values"
import { useSyncRuntime } from "./sync-runtime-context"
import { getSessionRevertMessageID } from "./session-message-records"

export function useSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_MESSAGES
    return store.getState().message[sessionID] ?? EMPTY_MESSAGES
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.message[sessionID] !== previous.message[sessionID]) notify()
    })
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionMessagesSelector<T>(
  sessionID: string,
  directory: string | undefined,
  select: (messages: Message[], state: State) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  watchParts = false,
): T {
  const store = useDirectoryStore(directory)
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const next = select(sessionID ? state.message[sessionID] ?? EMPTY_MESSAGES : EMPTY_MESSAGES, state)
    const cached = cacheRef.current
    if (cached && isEqual(cached.value, next)) return cached.value
    cacheRef.current = { value: next }
    return next
  }, [isEqual, select, sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.message[sessionID] !== previous.message[sessionID] || (watchParts && state.part !== previous.part)) notify()
    })
  }, [sessionID, store, watchParts])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

const EMPTY_PARTS_BY_MESSAGE: Record<string, Part[]> = {}

export function useSessionPartsForMessages(
  messageIDs: readonly string[],
  directory?: string,
  isEqual?: (previous: Record<string, Part[]>, next: Record<string, Part[]>) => boolean,
): Record<string, Part[]> {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{ ids: readonly string[]; read: Record<string, Part[]>; parts: Record<string, Part[]> } | null>(null)
  const getSnapshot = useCallback(() => {
    if (messageIDs.length === 0) return EMPTY_PARTS_BY_MESSAGE
    const state = store.getState()
    const cached = cacheRef.current
    if (
      cached
      && cached.ids === messageIDs
      && messageIDs.every((id) => (state.part[id] ?? EMPTY_PARTS) === (cached.read[id] ?? EMPTY_PARTS))
    ) {
      return cached.parts
    }
    const read: Record<string, Part[]> = {}
    for (const id of messageIDs) read[id] = state.part[id] ?? EMPTY_PARTS
    const parts = cached?.ids === messageIDs && isEqual?.(cached.parts, read) ? cached.parts : read
    cacheRef.current = { ids: messageIDs, read, parts }
    return parts
  }, [isEqual, messageIDs, store])
  const subscribe = useCallback((notify: () => void) => {
    if (messageIDs.length === 0) return () => undefined
    return store.subscribe((state, previous) => {
      for (const id of messageIDs) {
        if (state.part[id] !== previous.part[id]) {
          notify()
          return
        }
      }
    })
  }, [messageIDs, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionRenderable(sessionID: string, directory?: string): boolean {
  const runtime = useSyncRuntime()
  const store = useDirectoryStore(directory)
  const resolvedDirectory = React.useSyncExternalStore(
    runtime.currentDirectory.subscribe,
    () => directory ?? runtime.currentDirectory.get(),
  )
  const { messageLoader } = runtime
  const renderableRef = useRef(false)
  const getSnapshot = useCallback(() => {
    const renderable = Boolean(sessionID && getSessionMaterializationStatus(store.getState(), sessionID, {
      historyCovered: messageLoader.coversHistory({ directory: resolvedDirectory, sessionID }),
    }).renderable)
    renderableRef.current = renderable
    return renderable
  }, [messageLoader, resolvedDirectory, sessionID, store])
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!sessionID) return () => undefined
      const stopLoader = messageLoader.subscribe({ directory: resolvedDirectory, sessionID }, notify)
      const stopMessages = subscribeDirectorySessionMessages(store, sessionID, (change) => {
        const state = store.getState()
        const remainsRenderable = change.partMessageIDs.every((messageID) => (
          Object.prototype.hasOwnProperty.call(state.part, messageID)
        ))
        if (
          !change.messagesChanged
          && !change.reset
          && change.partMessageIDs.length > 0
          && renderableRef.current
          && remainsRenderable
        ) {
          countSyncPerformance("sessionRenderableNotificationSkips")
          return
        }
        notify()
      })
      return () => {
        stopLoader()
        stopMessages()
      }
    },
    [messageLoader, resolvedDirectory, sessionID, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()

const userHistoryRecordIDs = new WeakMap<UserMessageHistorySnapshot["records"], ReadonlySet<string>>()

const getUserHistoryRecordIDs = (snapshot: UserMessageHistorySnapshot): ReadonlySet<string> => {
  let ids = userHistoryRecordIDs.get(snapshot.records)
  if (!ids) {
    ids = new Set(snapshot.records.map((record) => record.message.id))
    userHistoryRecordIDs.set(snapshot.records, ids)
  }
  return ids
}

export function useUserMessageHistory(sessionID: string, directory?: string): TranscriptPrompt[] {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<UserMessageHistorySnapshot>(EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT)

  const getSnapshot = useCallback(() => {
    const next = buildUserMessageHistorySnapshot(store.getState(), sessionID, snapshotRef.current)
    snapshotRef.current = next
    return next.history
  }, [sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    const unsubscribeMessages = subscribeDirectorySessionMessages(store, sessionID, (change) => {
      if (!change.messagesChanged && !change.reset && change.partMessageIDs.length > 0) {
        const snapshot = snapshotRef.current
        const recordIDs = snapshot.sessionID === sessionID ? getUserHistoryRecordIDs(snapshot) : EMPTY_RECORD_IDS
        const affectsUserHistory = change.partMessageIDs.some((messageID) => recordIDs.has(messageID))
        if (!affectsUserHistory) {
          countSyncPerformance("userMessageHistoryNotificationSkips")
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
  }, [sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
