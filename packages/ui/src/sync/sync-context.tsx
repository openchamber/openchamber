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

const SyncContext = createContext<SyncSystem | null>(null)

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

async function resyncDirectoryAfterReconnect(directory: string, store: StoreApi<DirectoryStore>) {
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
  }))
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
) {
  // Normalize directory path: SSE events from OpenCode use native OS separators
  // (backslashes on Windows) and may differ in drive-letter case.
  // Child stores are keyed with forward slashes and uppercase drive letters.
  const directory = rawDirectory && rawDirectory !== "global"
    ? rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
    : rawDirectory
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
  const store = childStores.getChild(directory)
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

  childStores.mark(directory)

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
        directory,
        session: sessionID,
        time: Date.now(),
        viewed: isViewedInCurrentSession(directory, sessionID),
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

  // Update global session status for cross-directory sidebar visibility
  if (payload.type === "session.status") {
    const props = payload.properties as { sessionID: string; status: SessionStatus }
    setGlobalSessionStatus(props.sessionID, props.status)
  }

  if (payload.type === "permission.asked") {
    const normalizedDirectory = normalizeDirectory(directory)
    if (!normalizedDirectory) {
      return
    }

    const permission = payload.properties as PermissionRequest
    const sessions = store.getState().session
    const autoAccept = usePermissionStore.getState().autoAccept
    if (autoRespondsPermission({ autoAccept, sessions, sessionID: permission.sessionID, directory: normalizedDirectory })) {
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
  }, [childStores, props.sdk])

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
        handleEvent(directory, payload, childStores)
      },
      onReconnect: () => {
        for (const [dir, store] of childStores.children) {
          if (reconnectResyncing.has(dir)) continue
          if (getReconnectCandidateSessionIds(store.getState()).length === 0) continue

          reconnectResyncing.add(dir)
          void resyncDirectoryAfterReconnect(dir, store)
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
  }, [props.sdk, childStores])

  // Ensure current directory's child store exists
  useEffect(() => {
    if (props.directory) {
      childStores.ensureChild(props.directory)
    }
  }, [props.directory, childStores])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(props.sdk, childStores, props.directory)
    setActionRefs(
      props.sdk,
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
    )
  }, [props.sdk, props.directory, childStores])

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

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(sessionID: string, directory?: string) {
  const messages = useVisibleSessionMessages(sessionID, directory)
  const store = useDirectoryStore(directory)

  // Track parts with a ref to avoid subscribing to entire state.part map.
  // Re-derive only when messages list changes or on store subscription.
  const prevPartsRef = useRef<Record<string, Part[]>>({})
  const [partsSnapshot, setPartsSnapshot] = React.useState<Record<string, Part[]>>({})

  React.useEffect(() => {
    const messageIds = messages.map((m) => m.id)
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending = false

    const flush = () => {
      timer = null
      pending = false
      const state = store.getState()
      const prev = prevPartsRef.current
      let changed = false
      const next: Record<string, Part[]> = {}
      for (const id of messageIds) {
        const parts = state.part[id] ?? EMPTY_PARTS
        // Preserve existing reference if parts haven't changed in the store
        next[id] = prev[id] === parts ? prev[id] : parts
        if (next[id] !== prev[id]) changed = true
      }
      if (changed || Object.keys(prev).length !== messageIds.length) {
        prevPartsRef.current = next
        setPartsSnapshot(next)
      }
    }

    // Initial sync
    flush()

    // Throttled subscription — batch rapid delta events into ~100ms updates
    const unsub = store.subscribe(() => {
      if (timer) {
        pending = true
        return
      }
      timer = setTimeout(() => {
        flush()
        if (pending) {
          pending = false
          timer = setTimeout(flush, 100)
        }
      }, 100)
    })

    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [messages, store])

  return useMemo(
    () => messages.map((msg) => ({
      info: msg,
      parts: partsSnapshot[msg.id] ?? EMPTY_PARTS,
    })),
    [messages, partsSnapshot],
  )
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
