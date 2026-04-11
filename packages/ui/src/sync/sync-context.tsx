/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { reduceGlobalEvent, applyGlobalProject, applyDirectoryEvent } from "./event-reducer"
import { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { retry } from "./retry"
import { updateStreamingState } from "./streaming"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { autoRespondsPermission, normalizeDirectory } from "@/stores/utils/permissionAutoAccept"
import { appendNotification } from "./notification-store"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import { create } from "zustand"
import * as sessionActions from "./session-actions"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  sdk: OpencodeClient
  directory: string
}

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

// ---------------------------------------------------------------------------
// Event handler — applies one SSE event at a time to the live store.
// Each event reads live state, creates a shallow draft, applies, writes back.
// React 18 batches synchronous setState calls automatically.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global session status store — cross-directory status tracking.
//
// OpenCode isolates sessions behind project navrails, so per-directory
// session_status is sufficient. OpenChamber shows all sessions in one sidebar,
// so we need a global view. Updated from handleEvent on every session.status.
// ---------------------------------------------------------------------------

interface GlobalSessionStatusStore {
  statuses: Record<string, SessionStatus>
}

const useGlobalSessionStatusStore = create<GlobalSessionStatusStore>(() => ({
  statuses: {},
}))

function setGlobalSessionStatus(sessionId: string, status: SessionStatus) {
  const current = useGlobalSessionStatusStore.getState().statuses
  if (current[sessionId] === status) return
  useGlobalSessionStatusStore.setState({
    statuses: { ...current, [sessionId]: status },
  })
}

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useGlobalSessionStatusStore((s) => s.statuses[sessionId])
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useGlobalSessionStatusStore((s) => s.statuses)
}

// Boot debounce — suppresses redundant refresh/re-bootstrap events during startup.
let bootingRoot = false
let bootedAt = 0
const BOOT_DEBOUNCE_MS = 1500
const RECONNECT_MESSAGE_LIMIT = 200
const RECONNECT_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!_activeDirectory || !_activeSession || !sessionId) return false
  if (directory !== _activeDirectory) return false
  return sessionId === _activeSession
}

function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

function setGlobalSessionStatuses(nextStatuses: Record<string, SessionStatus>) {
  const current = useGlobalSessionStatusStore.getState().statuses
  let changed = false
  const merged = { ...current }

  for (const [sessionId, status] of Object.entries(nextStatuses)) {
    if (!status || merged[sessionId] === status) continue
    merged[sessionId] = status
    changed = true
  }

  if (changed) {
    useGlobalSessionStatusStore.setState({ statuses: merged })
  }
}

function getReconnectCandidateSessionIds(state: State) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}

function toSessionStatus(status: Awaited<ReturnType<typeof opencodeClient.getSessionStatus>>[string]): SessionStatus | undefined {
  if (!status) return undefined
  if (status.type === "idle" || status.type === "busy") {
    return { type: status.type }
  }
  if (
    status.type === "retry"
    && typeof status.attempt === "number"
    && typeof status.message === "string"
    && typeof status.next === "number"
  ) {
    return {
      type: "retry",
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    }
  }
  return undefined
}

type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

const createEventRoutingIndex = (): EventRoutingIndex => ({
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
})

const normalizeEventDirectory = (rawDirectory: string): string => {
  if (!rawDirectory || rawDirectory === "global") {
    return rawDirectory
  }
  const normalized = rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
  // Strip trailing slashes to match child store keys (normalizeDirectoryPath in useDirectoryStore)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

const getSessionIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const sessionID = (info as { sessionID?: unknown }).sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (
    event.type === "message.removed"
    || event.type === "session.status"
    || event.type === "todo.updated"
    || event.type === "permission.asked"
    || event.type === "permission.replied"
    || event.type === "question.asked"
    || event.type === "question.replied"
    || event.type === "question.rejected"
    || event.type === "session.deleted"
  ) {
    const sessionID = props.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const sessionID = (part as { sessionID?: unknown }).sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "session.created" || event.type === "session.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  return null
}

const getMessageIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  if (event.type === "message.removed" || event.type === "message.part.delta" || event.type === "message.part.removed") {
    const messageID = props.messageID
    return typeof messageID === "string" && messageID.length > 0 ? messageID : null
  }

  if (event.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const messageID = (part as { messageID?: unknown }).messageID
    return typeof messageID === "string" && messageID.length > 0 ? messageID : null
  }

  return null
}

const setIndexedSessionDirectory = (routingIndex: EventRoutingIndex, sessionID: string, directory: string) => {
  if (!sessionID || !directory || directory === "global") {
    return
  }
  routingIndex.sessionDirectoryById.set(sessionID, directory)
}

const setIndexedSessionMessages = (
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

const ingestDirectoryStateIntoRoutingIndex = (
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

const findSessionInChildStores = (
  sessionID: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = store.getState()
    if (
      state.session.some((s) => s.id === sessionID)
      || Object.prototype.hasOwnProperty.call(state.message, sessionID)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
    ) {
      // Self-heal: populate the routing index so future events resolve instantly
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
      return dir
    }
  }
  return null
}

const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory) {
      return indexedDirectory
    }

    // Routing index miss — scan child stores for this session.
    // Covers optimistic sessions not yet indexed and events with wrong/empty directory.
    const found = findSessionInChildStores(sessionID, childStores, routingIndex)
    if (found) {
      return found
    }
  }

  const messageID = getMessageIdFromPayload(payload)
  if (messageID) {
    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory) {
        return indexedDirectory
      }
    }

    // Scan child stores for a store that has parts for this message
    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(store.getState().part, messageID)) {
        return dir
      }
    }
  }

  // Single-store fallback: if there's only one directory, use it
  if (
    (sessionID || messageID)
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

const updateRoutingIndexFromEvent = (
  routingIndex: EventRoutingIndex,
  directory: string,
  payload: Event,
) => {
  if (!directory || directory === "global") {
    return
  }

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
  }

  switch (payload.type) {
    case "session.created":
    case "session.updated": {
      const info = (payload.properties as { info?: Session }).info
      if (info?.id) {
        setIndexedSessionDirectory(routingIndex, info.id, directory)
      }
      return
    }

    case "session.deleted": {
      const deletedSessionID = (payload.properties as { sessionID?: string }).sessionID
      if (deletedSessionID) {
        removeIndexedSession(routingIndex, deletedSessionID)
      }
      return
    }

    case "message.updated": {
      const info = (payload.properties as { info?: Message }).info
      if (info?.id && info.sessionID) {
        setIndexedMessage(routingIndex, info.sessionID, info.id, directory)
      }
      return
    }

    case "message.removed": {
      const props = payload.properties as { sessionID?: string; messageID?: string }
      if (props.messageID) {
        removeIndexedMessage(routingIndex, props.messageID, props.sessionID)
      }
      return
    }

    case "message.part.updated": {
      const part = (payload.properties as { part?: Part }).part as (Part & { sessionID?: string; messageID?: string }) | undefined
      if (part?.messageID && part.sessionID) {
        setIndexedMessage(routingIndex, part.sessionID, part.messageID, directory)
      }
      return
    }

    default:
      return
  }
}

async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
) {
  const current = store.getState()
  const candidateSessionIds = getReconnectCandidateSessionIds(current)
  if (candidateSessionIds.length === 0) return

  const nextStatuses = await opencodeClient.getSessionStatusForDirectory(directory)
  const relevantStatuses: Record<string, SessionStatus> = {}

  for (const sessionId of candidateSessionIds) {
    const nextStatus = toSessionStatus(nextStatuses[sessionId])
    if (nextStatus) {
      relevantStatuses[sessionId] = nextStatus
    }
  }

  if (Object.keys(relevantStatuses).length > 0) {
    store.setState((state: DirectoryStore) => ({
      session_status: { ...state.session_status, ...relevantStatuses },
    }))
    setGlobalSessionStatuses(relevantStatuses)
  }

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  await Promise.all(candidateSessionIds.map(async (sessionId) => {
    const [sessionResponse, messageResponse] = await Promise.all([
      scopedClient.session.get({ sessionID: sessionId }).catch(() => null),
      scopedClient.session.messages({ sessionID: sessionId, limit: RECONNECT_MESSAGE_LIMIT }).catch(() => null),
    ])
    const session = sessionResponse?.data
    const records = messageResponse?.data
    if (!session || !records) return

    const nextSession = stripSessionDiffSnapshots(session)
    const nextMessages = records
      .filter((record) => !!record?.info?.id)
      .map((record) => stripMessageDiffSnapshots(record.info))
      .sort((a, b) => cmp(a.id, b.id))
    const nextMessageIds = new Set(nextMessages.map((message) => message.id))

    store.setState((state: DirectoryStore) => {
      const sessions = [...state.session]
      const sessionIndex = sessions.findIndex((item) => item.id === nextSession.id)
      let sessionChanged = false
      let sessionTotal = state.sessionTotal

      if (sessionIndex >= 0) {
        if (sessions[sessionIndex] !== nextSession) {
          sessions[sessionIndex] = nextSession
          sessionChanged = true
        }
      } else {
        sessions.push(nextSession)
        sessions.sort((a, b) => cmp(a.id, b.id))
        if (!nextSession.parentID) sessionTotal += 1
        sessionChanged = true
      }

      const nextPartState = { ...state.part }
      const previousMessages = state.message[sessionId] ?? []
      for (const message of previousMessages) {
        if (!nextMessageIds.has(message.id)) {
          delete nextPartState[message.id]
        }
      }
      for (const record of records) {
        const messageId = record?.info?.id
        if (!messageId) continue
        nextPartState[messageId] = (record.parts ?? [])
          .filter((part) => !!part?.id && !RECONNECT_SKIP_PARTS.has(part.type))
          .sort((a, b) => cmp(a.id, b.id))
      }

      return {
        ...(sessionChanged ? { session: sessions, sessionTotal } : {}),
        message: { ...state.message, [sessionId]: nextMessages },
        part: nextPartState,
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, nextMessages)
  }))

  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
) {
  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores)

  // Global events
  if (directory === "global" || !directory) {
    const recent = isRecentBoot()
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      // Suppress refresh during/shortly after bootstrap
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    // On server.connected / global.disposed, re-bootstrap all directories
    // but only if not during recent boot
    if (payload.type === "server.connected" || payload.type === "global.disposed") {
      if (!recent) {
        for (const dir of childStores.children.keys()) {
          const store = childStores.getChild(dir)
          if (store && store.getState().status !== "loading") {
            // Mark as loading to trigger re-bootstrap
            store.setState({ status: "loading" as const })
            childStores.ensureChild(dir)
          }
        }
      }
    }
    return
  }

  // Directory events
  let store = childStores.getChild(directory)
  let resolvedDirectory = directory

  if (!store) {
    // Store not found for this directory — attempt recovery by scanning
    // child stores for the session. This handles directory mismatches
    // (trailing slashes, case differences, events with wrong directory).
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (!store) {
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    return
  }

  childStores.mark(resolvedDirectory)

  // Notification dispatch for session turn-complete and error events.
  // These are NOT handled by the event reducer — only the notification store.
  if (payload.type === "session.idle" || payload.type === "session.error") {
    const props = payload.properties as { sessionID?: string; error?: { message?: string; code?: string } }
    const sessionID = props.sessionID
    // Skip subtask sessions — only top-level sessions generate notifications
    const storeState = store.getState()
    const session = storeState.session.find((s) => s.id === sessionID)
    if (session && (session as { parentID?: string }).parentID) {
      // subtask — skip notification
    } else if (sessionID) {
      appendNotification({
        directory: resolvedDirectory,
        session: sessionID,
        time: Date.now(),
        viewed: isViewedInCurrentSession(resolvedDirectory, sessionID),
        ...(payload.type === "session.error"
          ? { type: "error" as const, error: props.error }
          : { type: "turn-complete" as const }),
      })
    }
  }

  // Read live state, create targeted draft cloning ONLY fields the event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = store.getState()
  const draft: State = { ...current }

  switch (payload.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      draft.session = [...current.session]
      draft.permission = { ...current.permission }
      draft.todo = { ...current.todo }
      draft.part = { ...current.part }
      break
    case "session.diff":
      draft.session_diff = { ...current.session_diff }
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      draft.session_status = { ...(current.session_status ?? {}) }
      break
    case "todo.updated":
      draft.todo = { ...current.todo }
      break
    case "message.updated":
      draft.message = { ...current.message }
      break
    case "message.removed":
      draft.message = { ...current.message }
      draft.part = { ...current.part }
      break
    case "message.part.updated":
    case "message.part.removed":
    case "message.part.delta":
      draft.part = { ...current.part }
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      draft.permission = { ...current.permission }
      break
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      draft.question = { ...current.question }
      break
    case "lsp.updated":
      draft.lsp = [...current.lsp]
      break
    default:
      break
  }

  if (applyDirectoryEvent(draft, payload)) {
    store.setState(draft)
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)

  // Update global session status for cross-directory sidebar visibility
  if (payload.type === "session.status") {
    const props = payload.properties as { sessionID: string; status: SessionStatus }
    setGlobalSessionStatus(props.sessionID, props.status)
  }

  if (payload.type === "session.idle" || payload.type === "session.error") {
    const props = payload.properties as { sessionID: string }
    setGlobalSessionStatus(props.sessionID, { type: "idle" })
  }

  if (payload.type === "permission.asked") {
    const nd = normalizeDirectory(resolvedDirectory)
    if (!nd) {
      return
    }

    const permission = payload.properties as PermissionRequest
    const sessions = store.getState().session
    const autoAccept = usePermissionStore.getState().autoAccept
    if (autoRespondsPermission({ autoAccept, sessions, sessionID: permission.sessionID, directory: nd })) {
      void sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  children: React.ReactNode
}) {
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      sdk: props.sdk,
      directory: props.directory,
    }),
    [childStores, props.sdk, props.directory],
  )

  // Configure child store manager
  useEffect(() => {
    const bootingDirs = new Set<string>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (bootingDirs.has(directory)) return
        bootingDirs.add(directory)

        const store = childStores.getChild(directory)
        if (!store) return

        const runBootstrap = async (attempt: number) => {
          const globalState = useGlobalSyncStore.getState()
          await bootstrapDirectory({
            directory,
            sdk: props.sdk,
            getState: () => store.getState(),
            set: (patch) => {
              store.setState(patch)
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
              if (patch.session_status) {
                const current = useGlobalSessionStatusStore.getState().statuses
                const merged = { ...current, ...patch.session_status }
                useGlobalSessionStatusStore.setState({ statuses: merged })
              }
            },
            global: {
              config: globalState.config,
              projects: globalState.projects,
              providers: globalState.providers,
            },
            loadSessions: (dir) => retry(async () => {
              const result = await props.sdk.session.list({
                directory: dir,
                roots: true,
                limit: 50,
              })
              // SDK returns { error } instead of { data } on non-ok responses (503).
              // Throw so retry() retries and allSettled marks it as rejected.
              if ((result as { error?: unknown }).error) {
                throw new Error("session.list failed: " + String((result as { error?: unknown }).error))
              }
              const sessions = (result.data ?? [])
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              store.setState({ session: sessions, sessionTotal: sessions.length, limit: Math.max(sessions.length, 50) })
              ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
            }),
          })

          // VS Code race: if sessions are still empty after bootstrap, OpenCode
          // wasn't ready yet (bridge returned 503). Retry a few times.
          const state = store.getState()
          if (state.session.length === 0 && attempt < 5) {
            await new Promise((r) => setTimeout(r, 2000))
            store.setState({ status: "loading" as const })
            await runBootstrap(attempt + 1)
          }
        }

        runBootstrap(0).finally(() => {
          bootingDirs.delete(directory)
        })
      },
      onDispose: (directory) => {
        bootingDirs.delete(directory)
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
  }, [childStores, props.sdk, routingIndex])

  // Bootstrap global state — set bootingRoot/bootedAt to suppress
  // redundant refresh events during startup
  useEffect(() => {
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions
    bootstrapGlobal(props.sdk, globalActions.set)
      .then(() => {
        bootedAt = Date.now()
      })
      .finally(() => {
        bootingRoot = false
      })
  }, [props.sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const reconnectResyncing = new Set<string>()

    const { cleanup } = createEventPipeline({
      sdk: props.sdk,
      onEvent: (directory, payload) => {
        handleEvent(directory, payload, childStores, routingIndex)
      },
      onReconnect: () => {
        for (const [dir, store] of childStores.children) {
          if (reconnectResyncing.has(dir)) continue
          if (getReconnectCandidateSessionIds(store.getState()).length === 0) continue

          reconnectResyncing.add(dir)
          void resyncDirectoryAfterReconnect(dir, store, routingIndex)
            .catch(() => {
              // Transient failure during resync — next SSE event or reconnect will catch up.
            })
            .finally(() => {
              reconnectResyncing.delete(dir)
            })
        }
      },
    })
    return cleanup
  }, [props.sdk, childStores, routingIndex])

  // Ensure current directory's child store exists
  useEffect(() => {
    if (props.directory) {
      const store = childStores.ensureChild(props.directory)
      ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    }
  }, [props.directory, childStores, routingIndex])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      props.sdk,
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
    )
  }, [props.sdk, props.directory, childStores, routingIndex])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    const unsubscribe = store.subscribe((state) => {
      updateStreamingState(state)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the global sync store */
export function useGlobalSync() {
  return useGlobalSyncStore()
}

/** Access the global sync store with a selector */
export function useGlobalSyncSelector<T>(selector: (state: GlobalSyncStore) => T): T {
  return useGlobalSyncStore(selector)
}

/** Get the child store for a directory (defaults to current) */
export function useDirectoryStore(directory?: string): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  return system.childStores.ensureChild(dir)
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Get the revert messageID for a session (if reverted) */
export function useSessionRevertMessageID(sessionID: string, directory?: string): string | undefined {
  return useDirectorySync(
    useCallback((state: State) => {
      const session = state.session.find((s) => s.id === sessionID)
      return (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
    }, [sessionID]),
    directory,
  )
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.message[sessionID] ?? EMPTY_MESSAGES, [sessionID]),
    directory,
  )
}

/**
 * Get visible session messages — filters out reverted messages.
 * Filters out reverted messages (id >= session.revert.messageID).
 */
export function useVisibleSessionMessages(sessionID: string, directory?: string) {
  const messages = useSessionMessages(sessionID, directory)
  const revertMessageID = useSessionRevertMessageID(sessionID, directory)
  return useMemo(() => {
    if (!revertMessageID) return messages
    return messages.filter((m) => m.id < revertMessageID)
  }, [messages, revertMessageID])
}

/** Check whether the message list for a session has been loaded into sync state. */
export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

/** Get parts for a specific message */
export function useSessionParts(messageID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.part[messageID] ?? EMPTY_PARTS, [messageID]),
    directory,
  )
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session_status?.[sessionID], [sessionID]),
    directory,
  )
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get questions for a specific session */
export function useSessionQuestions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.question[sessionID] ?? EMPTY_QUESTION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const getSidebarSessionSignature = (session: Session, stableUpdatedAt: number): string => {
  const directory = (session as Session & { directory?: string | null }).directory ?? ''
  const parentID = (session as Session & { parentID?: string | null }).parentID ?? ''
  const projectWorktree = (session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? ''
  const shared = session.share?.url ?? ''
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.archived ? 1 : 0,
    directory,
    parentID,
    projectWorktree,
    shared,
    stableUpdatedAt,
  ].join('|')
}

/** Get sessions stabilized for sidebar tree rendering */
export function useSidebarSessions(directory?: string): Session[] {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{
    source: Session[]
    streamingSignature: string
    array: Session[]
    signatures: Map<string, string>
    sessionsById: Map<string, Session>
    stableUpdatedAtById: Map<string, number>
    streamingById: Map<string, boolean>
  } | null>(null)

  const getSnapshot = React.useCallback(() => {
    const state = store.getState()
    const source = state.session
    const cached = cacheRef.current
    const streamingSignature = source
      .map((session) => {
        const statusType = state.session_status?.[session.id]?.type
        const isStreaming = statusType === 'busy' || statusType === 'retry'
        return `${session.id}:${isStreaming ? 1 : 0}`
      })
      .join('|')

    if (cached && cached.source === source && cached.streamingSignature === streamingSignature) {
      return cached.array
    }

    const signatures = new Map<string, string>()
    const sessionsById = new Map<string, Session>()
    const stableUpdatedAtById = new Map<string, number>()
    const streamingById = new Map<string, boolean>()
    let changed = !cached || cached.array.length !== source.length

    const array = source.map((session) => {
      const rawUpdatedAt = Number(session.time?.updated ?? session.time?.created ?? 0)
      const statusType = state.session_status?.[session.id]?.type
      const isStreaming = statusType === 'busy' || statusType === 'retry'
      const cachedUpdatedAt = cached?.stableUpdatedAtById.get(session.id) ?? rawUpdatedAt
      const wasStreaming = cached?.streamingById.get(session.id) ?? false
      const stableUpdatedAt = isStreaming
        ? (wasStreaming ? cachedUpdatedAt : Math.max(rawUpdatedAt, cachedUpdatedAt, Date.now()))
        : cachedUpdatedAt
      const signature = getSidebarSessionSignature(session, stableUpdatedAt)
      signatures.set(session.id, signature)
      stableUpdatedAtById.set(session.id, stableUpdatedAt)
      streamingById.set(session.id, isStreaming)

      const cachedSession = cached?.sessionsById.get(session.id)
      if (
        cachedSession
        && cached?.signatures.get(session.id) === signature
      ) {
        sessionsById.set(session.id, cachedSession)
        return cachedSession
      }

      changed = true
      const nextSession = stableUpdatedAt === rawUpdatedAt
        ? session
        : {
            ...session,
            time: {
              ...session.time,
              updated: stableUpdatedAt,
            },
          }
      sessionsById.set(session.id, nextSession)
      return nextSession
    })

    if (!changed && cached) {
      cacheRef.current = {
        source,
        streamingSignature,
        array: cached.array,
        signatures,
        sessionsById: cached.sessionsById,
        stableUpdatedAtById,
        streamingById,
      }
      return cached.array
    }

    cacheRef.current = { source, streamingSignature, array, signatures, sessionsById, stableUpdatedAtById, streamingById }
    return array
  }, [store])

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  return useDirectorySync(
    useCallback(
      (state: State) => {
        if (!sessionID) return undefined
        return state.session.find((session) => session.id === sessionID)
      },
      [sessionID],
    ),
    directory,
  )
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  return useDirectorySync(
    useCallback(
      (state: State) => {
        if (!sessionID) return undefined
        const session = state.session.find((candidate) => candidate.id === sessionID)
        return (session as (typeof session & { directory?: string | null }) | undefined)?.directory ?? undefined
      },
      [sessionID],
    ),
    directory,
  )
}

/** Get the SDK client */
export function useSyncSDK() {
  return useSyncSystem().sdk
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncSystem().childStores
}

export type SessionTextMessage = {
  id: string
  role: string | null
  text: string
}

const getPartText = (part: Part): string => {
  if (part?.type !== "text") return ""
  const text = (part as { text?: unknown }).text
  return typeof text === "string" ? text : ""
}

const getConcatenatedTextFromParts = (parts: Part[]): string => {
  let text = ""
  for (const part of parts) {
    text += getPartText(part)
  }
  return text
}

const getFirstTextFromParts = (parts: Part[]): string => {
  for (const part of parts) {
    const text = getPartText(part)
    if (text.length > 0) return text
  }
  return ""
}

function usePartsSnapshotForMessageIds(messageIds: string[], directory?: string, suspendUpdates = false) {
  const store = useDirectoryStore(directory)
  const prevPartsRef = useRef<Record<string, Part[]>>({})
  const [partsSnapshot, setPartsSnapshot] = React.useState<Record<string, Part[]>>({})

  React.useEffect(() => {
    const flush = () => {
      const state = store.getState()
      const prev = prevPartsRef.current
      let changed = false
      const next: Record<string, Part[]> = {}
      for (const id of messageIds) {
        const parts = state.part[id] ?? EMPTY_PARTS
        next[id] = prev[id] === parts ? prev[id] : parts
        if (next[id] !== prev[id]) changed = true
      }
      if (changed || Object.keys(prev).length !== messageIds.length) {
        prevPartsRef.current = next
        setPartsSnapshot(next)
      }
    }

    flush()

    if (suspendUpdates) {
      return
    }

    const unsub = store.subscribe(flush)

    return () => {
      unsub()
    }
  }, [messageIds, store, suspendUpdates])

  return partsSnapshot
}

export function useSessionMessageCount(sessionID: string, directory?: string): number {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return 0
      return state.message[sessionID]?.length ?? 0
    }, [sessionID]),
    directory,
  )
}

export function useSessionTextMessages(sessionID: string, directory?: string): SessionTextMessage[] {
  const messages = useVisibleSessionMessages(sessionID, directory)
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages])
  const partsSnapshot = usePartsSnapshotForMessageIds(messageIds, directory)

  return useMemo(
    () => messages.map((message) => ({
      id: message.id,
      role: typeof message.role === "string" ? message.role : null,
      text: getConcatenatedTextFromParts(partsSnapshot[message.id] ?? EMPTY_PARTS),
    })),
    [messages, partsSnapshot],
  )
}

export function useUserMessageHistory(sessionID: string, directory?: string): string[] {
  const messages = useVisibleSessionMessages(sessionID, directory)
  const userMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages],
  )
  const userMessageIds = useMemo(() => userMessages.map((message) => message.id), [userMessages])
  const partsSnapshot = usePartsSnapshotForMessageIds(userMessageIds, directory)

  return useMemo(() => {
    const history: string[] = []
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const message = userMessages[index]
      const text = getFirstTextFromParts(partsSnapshot[message.id] ?? EMPTY_PARTS)
      if (text.length > 0) {
        history.push(text)
      }
    }
    return history
  }, [partsSnapshot, userMessages])
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { suspendPartUpdates?: boolean },
) {
  const messages = useVisibleSessionMessages(sessionID, directory)
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages])
  const partsSnapshot = usePartsSnapshotForMessageIds(messageIds, directory, Boolean(options?.suspendPartUpdates))
  const previousRecordsRef = useRef<{
    list: Array<{ info: (typeof messages)[number]; parts: Part[] }>
    byId: Map<string, { info: (typeof messages)[number]; parts: Part[] }>
  }>({
    list: [],
    byId: new Map(),
  })

  return useMemo(() => {
    const previous = previousRecordsRef.current
    const nextById = new Map<string, { info: (typeof messages)[number]; parts: Part[] }>()
    const nextList = messages.map((message) => {
      const parts = partsSnapshot[message.id] ?? EMPTY_PARTS
      const previousRecord = previous.byId.get(message.id)
      const record = previousRecord && previousRecord.info === message && previousRecord.parts === parts
        ? previousRecord
        : { info: message, parts }
      nextById.set(message.id, record)
      return record
    })

    const unchanged = previous.list.length === nextList.length
      && previous.list.every((record, index) => record === nextList[index])

    if (unchanged) {
      return previous.list
    }

    previousRecordsRef.current = {
      list: nextList,
      byId: nextById,
    }

    return nextList
  }, [messages, partsSnapshot])
}

/**
 * Determines if a session is actively working.
 * Checks session_status and only falls back to incomplete assistant messages
 * when authoritative status is missing.
 * Returns false when permissions are pending (permission indicator takes priority).
 */
export function useIsSessionWorking(sessionID: string, directory?: string): boolean {
  const status = useSessionStatus(sessionID, directory)
  const permissions = useSessionPermissions(sessionID, directory)
  const messages = useSessionMessages(sessionID, directory)

  return useMemo(() => {
    // Permissions pending → not "working" (show permission indicator instead)
    if (permissions.length > 0) return false

    // Check session_status
    const hasAuthoritativeStatus = status !== undefined
    const statusWorking = hasAuthoritativeStatus && status.type !== "idle"

    // Check for incomplete assistant message (fallback if status event delayed)
    let hasPendingAssistant = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && typeof (m as { time?: { completed?: number } }).time?.completed !== "number") {
        hasPendingAssistant = true
        break
      }
    }

    if (hasAuthoritativeStatus) return statusWorking
    return hasPendingAssistant
  }, [status, permissions, messages])
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
