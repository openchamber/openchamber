/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { reduceGlobalEvent, applyGlobalProject, applyDirectoryEvent, type SessionMaterializationReason } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import {
  ChildStoreManager,
  markDirectorySessionPartChanged,
  subscribeDirectoryPermission,
  subscribeDirectorySessionMessages,
  type DirectoryBootstrapContext,
  type DirectoryBootstrapReason,
  type DirectoryBootstrapPriority,
  type DirectoryStore,
} from "./child-store"
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
} from "./live-aggregate"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { retry } from "./retry"
import { touchStreamingSession, updateChangedStreamingSessions, updateStreamingState } from "./streaming"
import { countSyncPerformance } from "./performance-diagnostics"
import { setActionRefs } from "./session-actions"
import { setSyncRefs, getAllSyncSessions } from "./sync-refs"
import { stripSessionDiffSnapshots } from "./sanitize"
import { applySessionEventToGlobalSessions } from "./session-event-router"
import { syncDebug } from "./debug"
import { getReconnectCandidateSessionIds, mergeBootstrapSessions } from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { processVSCodePermissionAutoAccept } from "./vscode-permission-auto-accept"
import { useConfigStore } from "@/stores/useConfigStore"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { toast } from "@/components/ui"
import { appendNotification } from "./notification-store"
import { applyGlobalSessionStatusEvent, applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from "./global-session-status"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import {
  getSessionMaterializationRequestKey,
  getSessionMaterializationStatus,
  isSessionMaterializationStillNeeded,
  type SessionMaterializationRequest,
} from "./materialization"
import { openSessionFromToast } from "./session-navigation"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { listGlobalSessionPages } from "@/stores/globalSessions"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests } from "./scoped-blocking-requests"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type UserMessageHistorySnapshot } from "./user-message-history"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  EMPTY_SESSION_MESSAGE_LOAD_STATE,
  SessionMessageLoader,
  getImperativeSessionMessageLoader,
  setImperativeSessionMessageLoader,
  type SessionMessageLoadState,
} from "./session-message-loader"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  messageLoader: SessionMessageLoader
  runtimeKey: string
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

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (!result.error) return result.data
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(
  selector: (states: State[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  subscribe?: (childStores: ChildStoreManager, notify: () => void) => () => void,
): T {
  const { childStores } = useSyncSystem()
  const cacheRef = useRef<T | undefined>(undefined)
  const initializedRef = useRef(false)

  const getSnapshot = useCallback(() => {
    const next = selector(getLiveStates(childStores))
    if (initializedRef.current && isEqual(cacheRef.current as T, next)) {
      return cacheRef.current as T
    }

    cacheRef.current = next
    initializedRef.current = true
    return next
  }, [childStores, isEqual, selector])

  return React.useSyncExternalStore(
    useCallback(
      (notify) => subscribe ? subscribe(childStores, notify) : childStores.subscribeAll(notify),
      [childStores, subscribe],
    ),
    getSnapshot,
    getSnapshot,
  )
}

// ---------------------------------------------------------------------------
// Event handler — applies ordered SSE events to a cumulative per-flush draft.
// Per-event side effects remain ordered, while each directory store publishes
// once and each touched top-level slice is cloned at most once per flush.
// ---------------------------------------------------------------------------

type DirectoryEventBatch = {
  states: Map<StoreApi<DirectoryStore>, DirectoryStore>
  clonedFields: Map<StoreApi<DirectoryStore>, Set<keyof State>>
  changedStores: Set<StoreApi<DirectoryStore>>
}

const createDirectoryEventBatch = (): DirectoryEventBatch => ({
  states: new Map(),
  clonedFields: new Map(),
  changedStores: new Set(),
})

const getDirectoryEventState = (
  store: StoreApi<DirectoryStore>,
  batch?: DirectoryEventBatch,
): DirectoryStore => batch?.states.get(store) ?? store.getState()

const publishDirectoryEventBatch = (batch: DirectoryEventBatch): void => {
  for (const store of batch.changedStores) {
    const state = batch.states.get(store)
    if (!state) continue
    countSyncPerformance("directoryStorePublications")
    store.setState(state)
  }
}

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useGlobalSessionStatusStore(
    useCallback((state) => state.statusById.get(sessionId)?.status, [sessionId]),
  )
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessionStatuses(states), []),
    areStatusMapsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session_status,
        notify,
      ),
      [],
    ),
  )
}

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessions(states), []),
    areSessionListsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session,
        notify,
      ),
      [],
    ),
  )
}

// Boot debounce — suppresses redundant refresh/re-bootstrap events during startup.
let bootingRoot = false
let bootedAt = 0
let globalBootstrapGeneration = 0
const BOOT_DEBOUNCE_MS = 1500
const RECONNECT_MESSAGE_LIMIT = 30
const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30
const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STALE_EVENT_MS = 20_000
const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000
const CHILD_SESSION_DISCOVERY_INTERVAL_MS = 15_000
const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

// ---------------------------------------------------------------------------
// Session materialization scheduler — when local message/part state is incomplete,
// fetch the canonical session snapshot and materialize messages and parts together.
// Tracked per-runtime and directory, deduplicated, and auto-expiring.
// ---------------------------------------------------------------------------

type PendingSessionMaterialization = {
  runtimeKey: string
  sessionID: string
  directory: string
  enqueuedAt: number
  request: SessionMaterializationRequest
}

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000
const pendingSessionMaterializations = new Map<string, PendingSessionMaterialization>()

function enqueueSessionMaterialization(
  directory: string,
  sessionID: string,
  childStores: ChildStoreManager,
  request: SessionMaterializationRequest,
) {
  if (!directory || directory === "global" || !sessionID) return
  const runtimeKey = getRuntimeKey()
  const k = getSessionMaterializationRequestKey(runtimeKey, directory, sessionID)
  const existing = pendingSessionMaterializations.get(k)
  if (existing && Date.now() - existing.enqueuedAt < SESSION_MATERIALIZATION_COOLDOWN_MS) return

  const pending = { runtimeKey, sessionID, directory, enqueuedAt: Date.now(), request }
  pendingSessionMaterializations.set(k, pending)
  countSyncPerformance("materializationEnqueues")
  if (request.reason === "empty-assistant-message") {
    countSyncPerformance("materializationEmptyAssistantEnqueues")
  } else if (request.reason === "missing-owning-message") {
    countSyncPerformance("materializationMissingMessageEnqueues")
  } else if (request.reason === "orphan-delta" || request.reason === "missing-delta-part") {
    countSyncPerformance("materializationMissingPartEnqueues")
  } else {
    countSyncPerformance("materializationLifecycleEnqueues")
  }

  const run = async () => {
    if (pending.runtimeKey !== getRuntimeKey()) {
      if (pendingSessionMaterializations.get(k) === pending) {
        pendingSessionMaterializations.delete(k)
      }
      return
    }
    const store = childStores.getChild(directory)
    if (!store) {
      if (pendingSessionMaterializations.get(k) === pending) {
        pendingSessionMaterializations.delete(k)
      }
      return
    }
    try {
      if (!isSessionMaterializationStillNeeded(store.getState(), sessionID, request)) {
        countSyncPerformance("materializationPreflightSkips")
        return
      }
      countSyncPerformance("materializationRequests")
      await materializeSessionFromServer(directory, sessionID, store, request)
    } catch {
      // Transient failure — next SSE event or reconnect will catch up.
    } finally {
      const remainingCooldown = SESSION_MATERIALIZATION_COOLDOWN_MS - (Date.now() - pending.enqueuedAt)
      if (remainingCooldown <= 0) {
        if (pendingSessionMaterializations.get(k) === pending) {
          pendingSessionMaterializations.delete(k)
        }
      } else {
        setTimeout(() => {
          if (pendingSessionMaterializations.get(k) === pending) {
            pendingSessionMaterializations.delete(k)
          }
        }, remainingCooldown)
      }
    }
  }

  // Start after the current ordered event batch, then recheck local state
  // before issuing HTTP in case another event in the batch repaired it.
  void Promise.resolve().then(run)
}

async function materializeSessionFromServer(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
  options?: SessionMaterializationRequest & { isStale?: () => boolean },
) {
  const statusBeforeMaterialization = store.getState().session_status?.[sessionID]
  syncDebug.recovery.materializing({
    reason: options?.reason ?? "ensure-session-messages",
    directory,
    sessionID,
    messageID: options?.messageID,
    partID: options?.partID,
  })
  const loader = getImperativeSessionMessageLoader()
  if (!loader || options?.isStale?.()) return
  await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
  if (loader.getSnapshot({ directory, sessionID }).status === "error") {
    throw loader.getSnapshot({ directory, sessionID }).error ?? new Error("Session materialization failed")
  }

  if (statusBeforeMaterialization && statusBeforeMaterialization.type !== "idle" && !options?.isStale?.()) {
    await resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative")
  }
}

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""
const externallyViewedSessions = new Map<string, number>()
const EXTERNAL_VIEW_TTL_MS = 15_000

const viewedSessionKey = (directory: string, sessionId: string) => `${directory}\n${sessionId}`

function pruneExternallyViewedSessions(now = Date.now()) {
  for (const [key, expiresAt] of externallyViewedSessions.entries()) {
    if (expiresAt <= now) {
      externallyViewedSessions.delete(key)
    }
  }
}
const pendingQuestionToastIds = new Set<string>()
const pendingPermissionToastIds = new Set<string>()
const pendingVSCodePermissionEvents = new Map<string, symbol>()

const getVSCodePermissionEventKey = (
  runtimeKey: string,
  directory: string,
  sessionID?: string,
  requestID?: string,
): string | null => {
  const requestKey = getPermissionToastKey(sessionID, requestID)
  return requestKey ? JSON.stringify([runtimeKey, directory, requestKey]) : null
}

const getQuestionToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

type UiNotificationPayload = {
  title?: unknown
  body?: unknown
  tag?: unknown
  kind?: unknown
  sessionId?: unknown
  directory?: unknown
  requireHidden?: unknown
  desktopNotificationDelivered?: unknown
  desktopStdoutActive?: unknown
}

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const handleUiNotificationEvent = (payload: Event, fallbackDirectory: string): boolean => {
  if ((payload as { type?: unknown }).type !== "openchamber:notification") {
    return false
  }

  const properties = (payload as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return true
  }

  const notification = properties as UiNotificationPayload
  if ((notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true) && getRuntimeKey() === "local") {
    return true
  }

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) {
    return true
  }

  void notifications.notifyAgentCompletion({
    title: asOptionalString(notification.title),
    body: asOptionalString(notification.body),
    tag: asOptionalString(notification.tag),
    kind: asOptionalString(notification.kind),
    sessionId: asOptionalString(notification.sessionId),
    directory: asOptionalString(notification.directory) ?? (fallbackDirectory && fallbackDirectory !== "global" ? fallbackDirectory : undefined),
    requireHidden: notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })

  return true
}

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
}

// The window must actually be focused for the active session to count as
// "seen": if the app is minimized or in the background, a turn finishing in the
// currently-selected session should still raise an unseen marker (in the tray
// and in-app), since the user isn't looking at it.
function isWindowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus()
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (
    _activeDirectory && _activeSession
    && directory === _activeDirectory && sessionId === _activeSession
    && isWindowFocused()
  ) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(directory, sessionId))
}

function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

function getViewedSessionMaterializationTarget(directory: string) {
  if (!_activeDirectory || !_activeSession) return null
  if (directory !== _activeDirectory) return null
  return {
    directory: _activeDirectory,
    sessionId: _activeSession,
  }
}

function toSessionStatus(status: Awaited<ReturnType<typeof opencodeClient.getSessionStatus>>[string] | undefined): SessionStatus | undefined {
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

function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getSessionStatusForDirectory>>
>

// How a /session/status snapshot is reconciled into the store.
//
// The directory-scoped snapshot lists only active (busy/retry) sessions; an
// absent candidate means "idle per this snapshot".
//
// - "monotonic": only confirm/raise active status. Never lowers a busy/retry
//   session to idle. Used by the periodic watchdog poll — real idle arrives via
//   SSE (session.status / session.idle) or via an authoritative resync that the
//   watchdog escalates to when it detects a stale busy entry. This keeps the
//   blind 5s poll from clobbering live state on a transient/misscoped snapshot.
// - "authoritative": treat the snapshot as ground truth — absent/idle candidates
//   are lowered to idle. Used by reconnect/escalated resyncs, a deliberate edge
//   where the live server snapshot is the source of truth (mirrors the bootstrap
//   snapshot). The snapshot wins over any derived message state here.
type StatusSnapshotMode = "monotonic" | "authoritative"

export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    const draft = () => (next ??= { ...current })

    for (const sessionId of candidateSessionIds) {
      const incoming = toSessionStatus(snapshot[sessionId])

      if (incoming && incoming.type !== "idle") {
        // Confirm or raise active status (catches a busy event the SSE missed).
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        continue
      }

      // Snapshot reports this candidate idle (absent, or explicit idle).
      // Monotonic never lowers; authoritative trusts the snapshot as truth.
      if (mode === "monotonic") continue

      const existing = current[sessionId]
      if (existing && existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    return next ? { session_status: next } : state
  })

  return changed
}

async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
): Promise<DirectorySessionStatusSnapshot | null> {
  const nextStatuses = await opencodeClient.getSessionStatusForDirectory(directory)
  // null = fetch failed; preserve existing state. {} or populated = a snapshot
  // of active sessions — reconciled per `mode` (absence ≠ idle under monotonic).
  if (nextStatuses === null) return null
  applySessionStatusSnapshot(store, nextStatuses, candidateSessionIds, mode)
  if (mode === "authoritative") {
    applyGlobalSessionStatusSnapshot(directory, nextStatuses, candidateSessionIds)
  }
  return nextStatuses
}

// After a monotonic poll, decide whether to escalate to a full authoritative
// resync: the store believes the session is active but the snapshot reports it
// idle/absent — a suspected missed idle that the monotonic poll deliberately
// won't lower on its own. The authoritative resync is the recovery path.
export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}

// Decide whether the event stream is genuinely stale and warrants a full
// resync. Uses stream activity that includes heartbeats, so a quiet-but-
// connected session (only receiving heartbeats) is NOT considered stale.
// A stale signal means no events at all — including no heartbeats — for the
// configured threshold, which is strong evidence the connection is dead.
// Returns false when lastStreamActivityAt is 0 (no events received yet),
// so the watchdog does not fire before the stream has delivered its first
// heartbeat.
export function shouldTriggerStaleResync(
  lastStreamActivityAt: number,
  lastFullResyncAt: number,
  now: number,
  staleThresholdMs: number = ACTIVE_SESSION_STALE_EVENT_MS,
  resyncCooldownMs: number = ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS,
): boolean {
  if (lastStreamActivityAt <= 0) return false
  if (now - lastStreamActivityAt < staleThresholdMs) return false
  if (now - lastFullResyncAt < resyncCooldownMs) return false
  return true
}

type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

const SHOULD_DISPATCH_VSCODE_NOTIFICATIONS = isVSCodeRuntime()

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: Event) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
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
  ) {
    const sessionID = props.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "session.deleted") {
    const sessionID = props.sessionID
    if (typeof sessionID === "string" && sessionID.length > 0) return sessionID
    const info = props.info
    const id = info && typeof info === "object" ? (info as { id?: unknown }).id : undefined
    return typeof id === "string" && id.length > 0 ? id : null
  }

  if (event.type === "message.part.updated") {
    const sessionID = props.sessionID
    if (typeof sessionID === "string" && sessionID.length > 0) {
      return sessionID
    }

    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const partSessionID = (part as { sessionID?: unknown }).sessionID
    return typeof partSessionID === "string" && partSessionID.length > 0 ? partSessionID : null
  }

  if (event.type === "message.part.delta" || event.type === "message.part.removed") {
    const sessionID = props.sessionID
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
    const partMessageID = (part as { messageID?: unknown }).messageID
    return typeof partMessageID === "string" && partMessageID.length > 0 ? partMessageID : null
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
  batch?: DirectoryEventBatch,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = getDirectoryEventState(store, batch)
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

const getActiveDirectoryFallback = (childStores: ChildStoreManager): string | null => {
  if (!_activeDirectory || !_activeSession) return null
  return childStores.getChild(_activeDirectory) ? _activeDirectory : null
}

const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID, batch)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
    }

    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    // Routing index miss — scan child stores for this session.
    // Covers optimistic sessions not yet indexed and events with wrong/empty directory.
    const found = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
    if (found) {
      return found
    }
  }

  const messageID = getMessageIdFromPayload(payload)
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

    // Scan child stores for a store that has parts for this message
    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(getDirectoryEventState(store, batch).part, messageID)) {
        return dir
      }
    }

    // Some reconnect/idle gaps can deliver part events before the matching
    // message.updated event and without a sessionID. If the user is actively
    // viewing a session, route the orphaned part event there so the reducer can
    // trigger HTTP materialization instead of dropping it as a global event.
    const activeDirectory = getActiveDirectoryFallback(childStores)
    if (activeDirectory) {
      return activeDirectory
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

const resolveMaterializationSessionID = (
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
  if (resolvedDirectory && resolvedDirectory === _activeDirectory && _activeSession) {
    return _activeSession
  }
  return undefined
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
      const props = payload.properties as { sessionID?: string; part?: Part }
      const part = props.part as (Part & { sessionID?: string; messageID?: string }) | undefined
      const sessionID = part?.sessionID ?? props.sessionID
      const messageID = part?.messageID
      if (messageID && sessionID) {
        setIndexedMessage(routingIndex, sessionID, messageID, directory)
      }
      return
    }

    default:
      return
  }
}

/**
 * Re-fetch pending questions and permissions for a directory and merge them
 * into the directory's child store, preserving any in-flight SSE updates that
 * arrived while the request was pending. Used by reconnect/materialization
 * recovery paths only; normal session switches rely on primary SSE reducer
 * state for `question.asked` / `permission.asked` events. When
 * `candidateSessionIds` is omitted, every session known to the directory store
 * is treated as a candidate.
 */
export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
) {
  const before = store.getState()
  const knownSessionIds = new Set<string>([
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.question ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  const candidates = candidateSessionIds ?? Array.from(knownSessionIds)
  if (candidates.length === 0) return

  // Re-fetch pending questions that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.question[sessionId])]),
    )
    const pendingQuestions = await opencodeClient.listPendingQuestions({ directories: [directory] })
    const grouped: Record<string, QuestionRequest[]> = {}
    for (const q of pendingQuestions) {
      if (!q?.id || !q.sessionID) continue
      if (!knownSessionIds.has(q.sessionID)) continue
      const list = grouped[q.sessionID]
      if (list) list.push(q)
      else grouped[q.sessionID] = [q]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    for (const [sessionId, questions] of Object.entries(grouped)) {
      const knownIds = new Set((before.question[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const question of questions) {
        if (knownIds.has(question.id)) continue
        const toastKey = getQuestionToastKey(sessionId, question.id)
        if (!toastKey || pendingQuestionToastIds.has(toastKey)) continue
        pendingQuestionToastIds.add(toastKey)
        const firstQuestion = question.questions?.[0]
        const title = firstQuestion?.header?.trim() || "Input needed"
        const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
        toast.info(title, {
          id: `question-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(sessionId, directory),
          },
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.question }
      for (const [sessionId, questions] of Object.entries(grouped)) {
        merged[sessionId] = questions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.question[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { question: merged }
    })
  } catch {
    // Non-fatal: question resync best-effort
  }

  // Re-fetch pending permissions — same rationale as questions.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!knownSessionIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    if (isVSCodeRuntime()) {
      const acceptedIdsBySession = new Map<string, Set<string>>()
      await Promise.all(Object.entries(grouped).flatMap(([sessionId, permissions]) =>
        permissions.map(async (permission) => {
          if (!(await processVSCodePermissionAutoAccept(permission, directory))) return
          const accepted = acceptedIdsBySession.get(sessionId) ?? new Set<string>()
          accepted.add(permission.id)
          acceptedIdsBySession.set(sessionId, accepted)
        }),
      ))

      for (const sessionId of Object.keys(grouped)) {
        const acceptedIds = acceptedIdsBySession.get(sessionId)
        if (!acceptedIds) continue
        const remaining = (grouped[sessionId] ?? []).filter((permission) => !acceptedIds.has(permission.id))
        if (remaining.length > 0) grouped[sessionId] = remaining
        else delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionToastIds,
          show: (title, options) => toast.info(title, options),
          openSession: openSessionFromToast,
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    // Non-fatal: permission resync best-effort
  }
}

async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
) {
  const current = store.getState()
  const candidateSessionIds = getActiveSessionCandidateIds(directory, current)
  if (candidateSessionIds.length === 0) return

  await resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "authoritative")

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  await Promise.all(candidateSessionIds.map(async (sessionId) => {
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const loader = getImperativeSessionMessageLoader()
    const [sessionResponse] = await Promise.all([
      retry(async () => {
        const response = await scopedClient.session.get({ sessionID: sessionId })
        assertSdkSuccess(response, "session.get")
        return response
      }).catch(() => null),
      loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT) ?? Promise.resolve(),
    ])
    const session = sessionResponse?.data
    if (!session) return

    const nextSession = stripSessionDiffSnapshots(session)
    store.setState((state: DirectoryStore) => {
      const sessionIndex = state.session.findIndex((item) => item.id === nextSession.id)
      let sessions = state.session
      let sessionChanged = false
      let sessionTotal = state.sessionTotal

      if (sessionIndex >= 0) {
        if (!haveEquivalentSyncSnapshots(sessions[sessionIndex], nextSession)) {
          sessions = [...state.session]
          sessions[sessionIndex] = nextSession
          sessionChanged = true
        }
      } else {
        sessions = [...state.session]
        sessions.push(nextSession)
        sessions.sort((a, b) => cmp(a.id, b.id))
        if (!nextSession.parentID) sessionTotal += 1
        sessionChanged = true
      }

      if (!sessionChanged) {
        return state
      }

      return {
        session: sessions,
        sessionTotal,
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, store.getState().message[sessionId] ?? [])
  }))

  await resyncBlockingRequestsForDirectory(directory, store, candidateSessionIds)

  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  skipVSCodeAutoAccept = false,
  streamingDirectory?: string,
  batch?: DirectoryEventBatch,
) {
  if ((payload as { type?: unknown }).type === "openchamber:permission-auto-accept.updated") {
    const properties = (payload as unknown as { properties?: unknown }).properties
    if (properties && typeof properties === "object") {
      const snapshot = properties as { sessions?: unknown; revision?: unknown }
      if (snapshot.sessions && typeof snapshot.sessions === "object") {
        usePermissionStore.getState().applySnapshot({
          sessions: snapshot.sessions as Record<string, boolean>,
          revision: typeof snapshot.revision === "number" ? snapshot.revision : undefined,
        }, expectedRuntimeKey)
      }
    }
    return
  }

  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores, batch)

  if (payload.type === "session.deleted" && expectedRuntimeKey === getRuntimeKey()) {
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID && directory && directory !== "global") {
      cleanupPersistedSessionState({ runtimeKey: expectedRuntimeKey, directory, sessionId: sessionID })
    }
  }

  if (handleUiNotificationEvent(payload, directory)) {
    return
  }

  applySessionEventToGlobalSessions(payload)
  // Keep the cross-project status map current for ALL directories (mirrors the
  // global-session handling above). Child stores remain the primary source for
  // synced directories; this map covers sessions a child store doesn't list
  // (unopened directories, or list/status races for just-created sessions).
  applyGlobalSessionStatusEvent(directory, payload)

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
            childStores.requestBootstrap({
              directory: dir,
              priority: dir === opencodeClient.getDirectory() ? "selected" : "background",
              reason: "server-connected",
              force: true,
            })
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
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
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

  if (payload.type === "permission.asked") {
    const permission = payload.properties as PermissionRequest
    if (isVSCodeRuntime() && !skipVSCodeAutoAccept) {
      const eventKey = getVSCodePermissionEventKey(expectedRuntimeKey, resolvedDirectory, permission.sessionID, permission.id)
      const eventToken = Symbol(eventKey ?? permission.id)
      if (eventKey) pendingVSCodePermissionEvents.set(eventKey, eventToken)
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      const completePermissionCheck = (accepted: boolean) => {
        if (eventKey && pendingVSCodePermissionEvents.get(eventKey) !== eventToken) return
        if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
        if (expectedRuntimeKey !== getRuntimeKey()) return
        if (!accepted) handleEvent(rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, true, streamingDirectory)
      }
      void processVSCodePermissionAutoAccept(permission, resolvedDirectory).then(
        completePermissionCheck,
        () => completePermissionCheck(false),
      )
      return
    }
    if (!isVSCodeRuntime() && usePermissionStore.getState().isSessionAutoAccepting(permission.sessionID)) {
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      return
    }

    const isViewed = isViewedInCurrentSession(resolvedDirectory, permission.sessionID)
    showPermissionNeededToast({
      permission,
      directory: resolvedDirectory,
      isViewed,
      pendingIds: pendingPermissionToastIds,
      show: (title, options) => toast.info(title, options),
      openSession: openSessionFromToast,
    })
  }

  if (payload.type === "permission.replied") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getPermissionToastKey(props.sessionID, props.requestID)
    const eventKey = getVSCodePermissionEventKey(expectedRuntimeKey, resolvedDirectory, props.sessionID, props.requestID)
    if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
    if (toastKey) {
      pendingPermissionToastIds.delete(toastKey)
      toast.dismiss(`permission-${toastKey}`)
    }
  }

  if (payload.type === "question.asked") {
    const question = payload.properties as QuestionRequest
    const sessionID = question.sessionID
    const toastKey = getQuestionToastKey(sessionID, question.id)
    const isViewed = isViewedInCurrentSession(resolvedDirectory, sessionID)
    if (!isViewed && toastKey && !pendingQuestionToastIds.has(toastKey)) {
      pendingQuestionToastIds.add(toastKey)
      const firstQuestion = question.questions?.[0]
      const title = firstQuestion?.header?.trim() || "Input needed"
      const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
      toast.info(title, {
        id: `question-${toastKey}`,
        description,
        action: {
          label: "Open session",
          onClick: () => openSessionFromToast(sessionID, resolvedDirectory),
        },
      })
    }
  }

  if (payload.type === "question.replied" || payload.type === "question.rejected") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getQuestionToastKey(props.sessionID, props.requestID)
    if (toastKey) {
      pendingQuestionToastIds.delete(toastKey)
      toast.dismiss(`question-${toastKey}`)
    }
  }

  if (payload.type === "file.watcher.updated" && resolvedDirectory !== "global") {
    const props = payload.properties as { file?: string }
    const file = props.file?.replace(/\\/g, "/")
    if (file && !file.includes("/.git/") && !file.startsWith(".git/")) {
      sessionEvents.requestVcsDiffRefresh({ directory: resolvedDirectory })
    }
  }

  // Notification dispatch for session turn-complete and error events.
  // These are NOT handled by the event reducer — only the notification store.
  if (payload.type === "session.idle" || payload.type === "session.error") {
    const props = payload.properties as { sessionID?: string; error?: { message?: string; code?: string } }
    const sessionID = props.sessionID
    // Skip subtask sessions — only top-level sessions generate notifications
    const storeState = getDirectoryEventState(store, batch)
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

  // Sync-layer parent resync: when a child session goes idle, recover
  // the parent session snapshot. This ensures the
  // parent's task tool part reflects the child's completion even when
  // no ToolPart component is mounted.
  if (payload.type === "session.idle") {
    const idleSessionId = getSessionIdFromPayload(payload)
    if (idleSessionId && resolvedDirectory && resolvedDirectory !== "global") {
      const sessionState = getDirectoryEventState(store, batch)
      const idleSession = sessionState.session.find((s) => s.id === idleSessionId)
      const parentID = idleSession
        ? (idleSession as Session & { parentID?: string | null }).parentID
        : null
      if (parentID) {
        enqueueSessionMaterialization(resolvedDirectory, parentID, childStores, { reason: "child-session-idle" })
      }
    }
  }

  // Read live state, create targeted draft cloning ONLY fields that event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = getDirectoryEventState(store, batch)
  const draft: State = { ...current }
  const clonedFields = batch?.clonedFields.get(store) ?? new Set<keyof State>()
  const newlyClonedFields: Array<keyof State> = []
  const cloneField = <K extends keyof State>(field: K, clone: (value: State[K]) => State[K]) => {
    if (clonedFields.has(field)) return
    Object.assign(draft, { [field]: clone(current[field]) })
    newlyClonedFields.push(field)
  }

  switch (payload.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      cloneField("session", (value) => [...value])
      cloneField("permission", (value) => ({ ...value }))
      cloneField("todo", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      cloneField("sessionEventRevision", (value) => ({ ...(value ?? {}) }))
      cloneField("sessionDeletedRevision", (value) => ({ ...(value ?? {}) }))
      break
    case "session.diff":
      cloneField("session_diff", (value) => ({ ...value }))
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      cloneField("session_status", (value) => ({ ...(value ?? {}) }))
      break
    case "todo.updated":
      cloneField("todo", (value) => ({ ...value }))
      break
    case "message.updated":
      cloneField("message", (value) => ({ ...value }))
      break
    case "message.removed":
      cloneField("message", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      break
    case "message.part.updated":
    case "message.part.removed":
    case "message.part.delta":
      cloneField("part", (value) => ({ ...value }))
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      cloneField("permission", (value) => ({ ...value }))
      break
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      cloneField("question", (value) => ({ ...value }))
      break
    case "lsp.updated":
      cloneField("lsp", (value) => [...value])
      break
    default:
      break
  }

  countSyncPerformance("reducerEvents")
  const reducerResult = applyDirectoryEvent(draft, payload, {
    onSetSessionTodo: (sessionID, todos) => {
      useTodosPersistStore.getState().setSessionTodos(resolvedDirectory, sessionID, todos)
    },
  })
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization

  if (reducerChanged) {
    countSyncPerformance("reducerChangedEvents")
    const eventSessionID = getSessionIdFromPayload(payload) ?? undefined
    const eventMessageID = getMessageIdFromPayload(payload) ?? undefined
    if (payload.type.startsWith("message.part.") && eventMessageID) {
      const partSessionID = eventSessionID ?? routingIndex.messageSessionById.get(eventMessageID)
      if (partSessionID) markDirectorySessionPartChanged(store, partSessionID, eventMessageID)
    }
    if (batch) {
      batch.states.set(store, draft as DirectoryStore)
      batch.changedStores.add(store)
      if (newlyClonedFields.length > 0) {
        newlyClonedFields.forEach((field) => clonedFields.add(field))
        batch.clonedFields.set(store, clonedFields)
      }
    } else {
      countSyncPerformance("directoryStorePublications")
      store.setState(draft)
    }
    const sessionID = eventSessionID
    const messageID = eventMessageID
    if (
      payload.type.startsWith("message.part.")
      && normalizeEventDirectory(resolvedDirectory) === normalizeEventDirectory(streamingDirectory ?? "")
    ) {
      const heartbeatSessionID = sessionID ?? (messageID ? routingIndex.messageSessionById.get(messageID) : undefined)
      if (heartbeatSessionID) touchStreamingSession(heartbeatSessionID)
    }
    const archived = payload.type === "session.updated"
      && Boolean(((payload.properties as { info?: Session }).info)?.time.archived)
    if (sessionID && (payload.type === "session.deleted" || archived)) {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID })
    }
    syncDebug.dispatch.eventApplied(payload.type, sessionID, messageID)

    // Snapshot materialization on message.updated: if the message was inserted or
    // replaced but draft.part[messageID] is empty, the parts were lost or
    // never arrived. Recover the session so the UI doesn't render a blank bubble.
    if (sessionID && messageID && payload.type === "message.updated") {
      const after = getDirectoryEventState(store, batch)
      const info = (payload.properties as { info: Message }).info
      if (info.role === "assistant" && !Object.prototype.hasOwnProperty.call(after.part, messageID)) {
        enqueueSessionMaterialization(resolvedDirectory, sessionID, childStores, {
          reason: "empty-assistant-message",
          messageID,
        })
      }
    }
  } else {
    const sessionID = getSessionIdFromPayload(payload) ?? undefined
    const messageID = getMessageIdFromPayload(payload) ?? undefined
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

  // Snapshot materialization is driven by typed reducer outcomes, not by
  // inferring meaning from a generic false/no-change result.
  if (materializationResult) {
    const materializationSessionID = resolveMaterializationSessionID(
      materializationResult.sessionID ?? getSessionIdFromPayload(payload) ?? undefined,
      materializationResult.messageID ?? getMessageIdFromPayload(payload) ?? undefined,
      resolvedDirectory,
      routingIndex,
    )
    if (materializationSessionID) {
      enqueueSessionMaterialization(resolvedDirectory, materializationSessionID, childStores, {
        reason: materializationResult.reason,
        messageID: materializationResult.messageID,
        partID: materializationResult.partID,
      })
    }
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

let bundledOpenCodeRuntimeCache: { runtimeKey: string; promise: Promise<boolean> } | null = null

const isBundledOpenCodeRuntime = async () => {
  const runtimeKey = getRuntimeKey()
  if (!bundledOpenCodeRuntimeCache || bundledOpenCodeRuntimeCache.runtimeKey !== runtimeKey) {
    bundledOpenCodeRuntimeCache = {
      runtimeKey,
      promise: runtimeFetch("/api/config/opencode-resolution", { signal: AbortSignal.timeout(4000) })
        .then(async (response) => {
          if (response.ok) {
            const resolution = await response.json() as { source?: unknown; detectedSourceNow?: unknown }
            return resolution.source === "bundled" || resolution.detectedSourceNow === "bundled"
          }

          const healthResponse = await runtimeFetch("/health", { signal: AbortSignal.timeout(4000) })
          if (!healthResponse.ok) return false
          const health = await healthResponse.json() as { opencodeBinarySource?: unknown }
          return health.opencodeBinarySource === "bundled"
        })
        .catch(() => false),
    }
  }
  return bundledOpenCodeRuntimeCache.promise
}

const dispatchOpenCodeUpdateAvailableUnlessBundled = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  void isBundledOpenCodeRuntime().then((isBundled) => {
    if (!isBundled) {
      dispatchOpenCodeUpdateAvailable(payload)
    }
  })
}

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  children: React.ReactNode
}) {
  // Capacitor apps were previously locked to SSE because Android WebSocket
  // upgrades appeared broken. Root cause was server-side: the Android WebView
  // origin (https://localhost, androidScheme 'https') was missing from the
  // packaged-client origin allowlist, so every WS upgrade was rejected with
  // 403. With the origin allowlisted, mobile uses the same transport
  // selection as everywhere else ('auto' falls back to SSE on WS failure).
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current
  const runtimeKey = getRuntimeKey()
  const messageLoaderRef = useRef<SessionMessageLoader | null>(null)
  if (!messageLoaderRef.current) {
    messageLoaderRef.current = new SessionMessageLoader(childStores, {
      sdk: props.sdk,
      runtimeKey,
    })
  }
  const messageLoader = messageLoaderRef.current
  messageLoader.configure({ sdk: props.sdk, runtimeKey })
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const currentDirectoryRef = useRef(props.directory)
  currentDirectoryRef.current = props.directory
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const lastChildDiscoveryAtByDirectoryRef = useRef(new Map<string, number>())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const statusPollingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      messageLoader,
      runtimeKey,
      sdk: props.sdk,
      directory: props.directory,
    }),
    [childStores, messageLoader, props.sdk, props.directory, runtimeKey],
  )

  const triggerDirectoryResync = useCallback((directory: string, reason: SessionMaterializationReason) => {
    const store = childStores.children.get(directory)
    if (!store) return
    const resyncing = resyncingDirectoriesRef.current
    if (resyncing.has(directory)) return

    lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    resyncing.add(directory)
    void resyncDirectoryAfterReconnect(directory, store, routingIndex, reason)
      .catch(() => {
        // Transient failure — the watchdog, next SSE event, or reconnect will catch up.
      })
      .finally(() => {
        resyncing.delete(directory)
      })
  }, [childStores, routingIndex])

  // Configure child store manager
  useEffect(() => {
    void usePermissionStore.getState().hydrate().catch(() => undefined)
  }, [props.sdk])

  useEffect(() => {
    return childStores.configure({
      bootstrapConcurrency: 2,
      onBootstrap: async (context: DirectoryBootstrapContext) => {
        const { directory } = context
        const store = childStores.getChild(directory)
        if (!store || !context.isCurrent()) return

        const runBootstrap = async (attempt: number): Promise<"complete" | "failed" | "stale"> => {
          if (!context.isCurrent()) return "stale"
          const globalState = useGlobalSyncStore.getState()
          const result = await bootstrapDirectory({
            directory,
            sdk: props.sdk,
            getState: () => store.getState(),
            set: (patch) => {
              if (!context.isLatest()) return
              store.setState(patch)
              if (patch.session_status) {
                applyGlobalSessionStatusSnapshot(directory, patch.session_status, store.getState().session.map((session) => session.id))
              }
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            isStale: () => !context.isLatest(),
            global: {
              config: globalState.config,
              projects: globalState.projects,
            },
            loadSessions: (dir) => retry(async () => {
              if (!context.isCurrent()) return
              const baselineRevision = store.getState().sessionRevision ?? 0
              const rootSessions = (await listGlobalSessionPages(props.sdk, {
                directory: dir,
                archived: false,
                roots: true,
                pageSize: 500,
              }))
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

              // Also load child sessions (sub-agent delegations) with pagination
              // so pending questions can scope to them immediately after restart.
              let allSessions: typeof rootSessions | null = null
              try {
                allSessions = await listGlobalSessionPages(props.sdk, {
                  directory: dir,
                  archived: false,
                  roots: false,
                  pageSize: 500,
                })
              } catch {
                // Child load is best-effort; fall back to roots only.
              }
              if (!context.isCurrent()) return

              // A cold OpenCode process can briefly return children before its
              // roots query catches up. Recover referenced parents from the
              // broader response or cache instead of publishing orphan rows.
              const current = store.getState()
              const { sessions, rootCount } = mergeBootstrapSessions(rootSessions, allSessions, current.session, {
                baselineRevision,
                eventRevision: current.sessionEventRevision,
                deletedRevision: current.sessionDeletedRevision,
              })
              store.setState({
                session: sessions,
                sessionTotal: rootCount,
                sessionListSource: "authoritative",
                limit: Math.max(sessions.length, 50),
              })
              ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
            }),
          })
          if (result !== "complete" || !context.isCurrent()) return result

          // VS Code-only race: the bridge can answer with an empty 200 (instead
          // of a retryable 503) while OpenCode is still warming up, which the two
          // retry layers inside loadSessions can't catch. Re-run a few times there.
          //
          // On web/desktop this retry is both redundant and harmful: loadSessions
          // already retries transient failures (listGlobalSessionPages throws on
          // 5xx and retries internally), so an empty result here is AUTHORITATIVE —
          // the directory genuinely has no sessions (e.g. a deleted worktree only
          // referenced by archived sessions). Re-running the full bootstrap 6×2s
          // per such directory is the startup log storm.
          if (isVSCodeRuntime() && context.isCurrent()) {
            const state = store.getState()
            if (state.session.length === 0 && attempt < 5) {
              console.warn(`[bootstrap] sessions empty for ${directory} after attempt ${attempt + 1}; retrying in 2s`)
              await new Promise((r) => setTimeout(r, 2000))
              if (!context.isCurrent()) return "stale"
              store.setState({ status: "loading" as const })
              return runBootstrap(attempt + 1)
            } else if (state.session.length === 0) {
              console.warn(`[bootstrap] sessions empty for ${directory} after ${attempt + 1} attempts; giving up`)
            }
          }
          return "complete"
        }

        const result = await runBootstrap(0)
        if (result === "failed") throw new Error(`Directory bootstrap failed for ${directory}`)
      },
      onDispose: (directory) => {
        messageLoader.invalidateDirectory(directory)
        lastStatusPollAtByDirectoryRef.current.delete(directory)
        lastFullResyncAtByDirectoryRef.current.delete(directory)
        lastChildDiscoveryAtByDirectoryRef.current.delete(directory)
      },
      isLoadingSessions: () => false,
    })
  }, [childStores, messageLoader, props.sdk, routingIndex])

  // Bootstrap global state — set bootingRoot/bootedAt to suppress
  // redundant refresh events during startup
  useEffect(() => {
    const generation = ++globalBootstrapGeneration
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions
    bootstrapGlobal(props.sdk, (patch) => {
      if (globalBootstrapGeneration === generation) {
        globalActions.set(patch)
      }
    })
      .then(() => {
        if (globalBootstrapGeneration === generation) {
          bootedAt = Date.now()
        }
      })
      .finally(() => {
        if (globalBootstrapGeneration === generation) {
          bootingRoot = false
        }
      })
    return () => {
      if (globalBootstrapGeneration === generation) {
        bootingRoot = false
      }
    }
  }, [props.sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const pipeline = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onEvents: (directory, payloads) => {
        // Track ALL stream activity (including heartbeats) as proof of
        // connection health. The watchdog stale check uses this to distinguish
        // a genuinely dead stream (no heartbeats for 20s) from a quiet-but-
        // connected session that is only receiving heartbeats. Excluding
        // heartbeats here caused issue #1656: the stale timer fired for any
        // quiet session, triggering redundant full resyncs every ~15s.
        lastStreamActivityAtRef.current = Date.now()
        const batch = createDirectoryEventBatch()
        try {
          for (const payload of payloads) {
            dispatchVSCodeRuntimeNotificationEvent(directory, payload)
            if (payload.type === "installation.update-available") {
              const version = typeof (payload.properties as { version?: unknown })?.version === "string"
                ? (payload.properties as { version: string }).version
                : ""
              if (version) {
                dispatchOpenCodeUpdateAvailableUnlessBundled({ version })
              }
            }
            handleEvent(directory, payload, childStores, routingIndex, runtimeKey, false, currentDirectoryRef.current, batch)
          }
        } finally {
          publishDirectoryEventBatch(batch)
        }
      },
      onReconnect: () => {
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        const isFirstConnect = !pipelineHasConnectedRef.current
        pipelineHasConnectedRef.current = true
        if (isFirstConnect && !pipelineDisconnectedBeforeFirstConnectRef.current) {
          return
        }
        if (isRecentBoot()) {
          return
        }
        for (const dir of childStores.children.keys()) {
          triggerDirectoryResync(dir, "stream-reconnect")
        }
      },
      onDisconnect: (reason) => {
        if (!pipelineHasConnectedRef.current) {
          pipelineDisconnectedBeforeFirstConnectRef.current = true
        }
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
          lastDisconnectReason: reason,
        })
      },
      onTransportSwitch: () => {
        // Transport changes are gap-prone in real networks. Treat them like a
        // reconnect and refresh active session snapshots from HTTP.
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        for (const dir of childStores.children.keys()) {
          triggerDirectoryResync(dir, "transport-switch")
        }
      },
    })
    pipelineReconnectRef.current = pipeline.reconnect
    return () => {
      if (pipelineReconnectRef.current === pipeline.reconnect) {
        pipelineReconnectRef.current = null
      }
      pipeline.cleanup()
    }
  }, [props.sdk, childStores, routingIndex, messageStreamTransport, runtimeKey, triggerDirectoryResync])

  useEffect(() => {
    let stopped = false
    let running = false

    const discoverChildSessions = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      parentSessionIds: string[],
    ) => {
      if (parentSessionIds.length === 0) return
      try {
        const scopedClient = opencodeClient.getScopedSdkClient(directory)
        const result = await scopedClient.session.list({ directory, limit: 200 })
        const allSessions = ((result as { data?: unknown }).data ?? []) as Session[]
        const state = store.getState()
        const existingIds = new Set(state.session.map((s) => s.id))
        const parentIdSet = new Set(parentSessionIds)
        const newChildSessions: Session[] = []
        for (const session of allSessions) {
          if (
            session?.id
            && !existingIds.has(session.id)
            && (session as { parentID?: string | null }).parentID
            && parentIdSet.has((session as { parentID: string }).parentID)
          ) {
            newChildSessions.push(session)
          }
        }
        if (newChildSessions.length === 0) return
        // Collect unique parent IDs for materialization
        const parentIdsForMaterialization = new Set<string>()
        for (const session of newChildSessions) {
          const pid = (session as { parentID?: string | null }).parentID
          if (pid) parentIdsForMaterialization.add(pid)
        }
        store.setState((state: DirectoryStore) => {
          const sessions = [...state.session, ...newChildSessions].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          )
          return { session: sessions, limit: Math.max(sessions.length, 50) }
        })
        // Trigger parent session materialization so the task tool part
        // state (metadata, sessionId, output) is refreshed.
        for (const pid of parentIdsForMaterialization) {
          enqueueSessionMaterialization(directory, pid, childStores, { reason: "child-session-discovered" })
        }
      } catch {
        // Best-effort — next tick will retry.
      }
    }

    const pollDirectoryStatuses = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      candidateSessionIds: string[],
    ) => {
      const polling = statusPollingDirectoriesRef.current
      if (polling.has(directory)) return
      polling.add(directory)
      try {
        const before = store.getState()
        const statuses = await resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "monotonic")
        if (!statuses) return
        const needsSnapshot = candidateSessionIds.some((sessionId) => (
          needsSnapshotAfterStatusPoll(before, sessionId, statuses[sessionId])
        ))
        if (needsSnapshot) {
          triggerDirectoryResync(directory, "stale-status-resync")
        }
      } finally {
        polling.delete(directory)
      }
    }

    const tick = () => {
      if (running || stopped) return
      running = true
      void Promise.resolve()
        .then(() => {
          if (stopped) return
          const now = Date.now()
          for (const [directory, store] of childStores.children.entries()) {
            const state = store.getState()
            const candidateSessionIds = getActiveSessionCandidateIds(directory, state)
            if (candidateSessionIds.length === 0) {
              lastStatusPollAtByDirectoryRef.current.delete(directory)
              lastFullResyncAtByDirectoryRef.current.delete(directory)
              continue
            }

            const lastStatusPollAt = lastStatusPollAtByDirectoryRef.current.get(directory) ?? 0
            if (now - lastStatusPollAt >= ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS) {
              lastStatusPollAtByDirectoryRef.current.set(directory, now)
              void pollDirectoryStatuses(directory, store, candidateSessionIds).catch(() => undefined)
            }

            const lastFullResyncAt = lastFullResyncAtByDirectoryRef.current.get(directory) ?? 0
            if (shouldTriggerStaleResync(lastStreamActivityAtRef.current, lastFullResyncAt, now)) {
              pipelineReconnectRef.current?.("active_stream_stale")
              triggerDirectoryResync(directory, "stale-status-resync")
            }

            // Discover child sessions created by other OpenCode instances
            // that didn't broadcast a session.created event on this stream.
            const lastChildDiscoveryAt = lastChildDiscoveryAtByDirectoryRef.current.get(directory) ?? 0
            if (now - lastChildDiscoveryAt >= CHILD_SESSION_DISCOVERY_INTERVAL_MS) {
              lastChildDiscoveryAtByDirectoryRef.current.set(directory, now)
              void discoverChildSessions(directory, store, candidateSessionIds)
            }
          }
        })
        .finally(() => {
          running = false
          if (stopped) {
            statusPollingDirectoriesRef.current.clear()
          }
        })
    }

    const interval = setInterval(tick, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS)
    tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [childStores, triggerDirectoryResync])

  // Ensure current directory's child store exists
  useEffect(() => {
    let seedExpiryTimer: ReturnType<typeof setTimeout> | undefined
    if (props.directory) {
      const store = childStores.ensureChild(props.directory, {
        priority: "selected",
        reason: "current-directory",
      })
      const statusSeed = getRuntimeLiveStatusSeed(getRuntimeKey(), props.directory)
      if (statusSeed) {
        store.setState((state: DirectoryStore) => ({
          session_status: {
            ...state.session_status,
            [statusSeed.sessionId]: state.session_status[statusSeed.sessionId] ?? statusSeed.status,
          },
        }))
        seedExpiryTimer = setTimeout(() => {
          store.setState((state: DirectoryStore) => {
            if (state.session_status[statusSeed.sessionId] !== statusSeed.status) {
              return state
            }
            return {
              session_status: {
                ...state.session_status,
                [statusSeed.sessionId]: { type: "idle" as const },
              },
            }
          })
        }, LIVE_STATUS_TTL_MS)
      }
      ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    }
    return () => {
      if (seedExpiryTimer) clearTimeout(seedExpiryTimer)
    }
  }, [props.directory, childStores, routingIndex])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setImperativeSessionMessageLoader(messageLoader)
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      props.sdk,
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
    )
    return () => {
      if (getImperativeSessionMessageLoader() === messageLoader) {
        setImperativeSessionMessageLoader(null)
      }
    }
  }, [props.sdk, props.directory, childStores, messageLoader, routingIndex])

  useEffect(() => () => {
    messageLoader.dispose()
    childStores.disposeAll()
  }, [childStores, messageLoader])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    updateStreamingState(store.getState())
    const unsubscribe = store.subscribe((state, previous) => {
      updateChangedStreamingSessions(state, previous)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Get the child store for a directory (defaults to current).
 *
 * Pass `{ bootstrap: false }` when you only need the store reference for an
 * on-demand `getState()` (not live subscription) and must NOT trigger a full
 * directory bootstrap. This avoids storms of pointless session-list fetches +
 * empty-retry loops for directories that are merely referenced by sidebar rows
 * (e.g. archived sessions on deleted worktrees).
 */
export function useDirectoryStore(
  directory?: string,
  options?: {
    bootstrap?: boolean
    priority?: DirectoryBootstrapPriority
    reason?: DirectoryBootstrapReason
  },
): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  const store = system.childStores.ensureChild(dir, options)

  useEffect(() => {
    system.childStores.pin(dir)
    return () => system.childStores.unpin(dir)
  }, [dir, system.childStores])

  return store
}

export function useSessionMessageLoader(): SessionMessageLoader {
  return useSyncSystem().messageLoader
}

export function useSessionMessageLoadState(sessionID: string, directory?: string): SessionMessageLoadState {
  const system = useSyncSystem()
  const runtimeKey = system.runtimeKey
  const target = useMemo(() => ({ directory: directory ?? system.directory, sessionID }), [directory, sessionID, system.directory])
  return React.useSyncExternalStore(
    useCallback((notify) => {
      void runtimeKey
      return sessionID && target.directory ? system.messageLoader.subscribe(target, notify) : () => undefined
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => {
      void runtimeKey
      return sessionID && target.directory
        ? system.messageLoader.getSnapshot(target)
        : EMPTY_SESSION_MESSAGE_LOAD_STATE
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => EMPTY_SESSION_MESSAGE_LOAD_STATE, []),
  )
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Get session messages for a specific session */
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
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return undefined
    return store.getState().session_status?.[sessionID]
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.session_status?.[sessionID] !== previous.session_status?.[sessionID]) notify()
    })
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string, options?: { bootstrap?: boolean }) {
  const store = useDirectoryStore(directory, options)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_PERMISSION_REQUESTS
    return store.getState().permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return subscribeDirectoryPermission(store, sessionID, notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

const selectPermissionRequestsBySession = (state: State) => state.permission
const selectQuestionRequestsBySession = (state: State) => state.question

type ScopedBlockingRequestCache<T extends { id: string }> = {
  sessionID: string | null
  sessions: Session[] | null
  requestsBySession: Record<string, T[] | undefined> | null
  result: T[]
}

function useScopedBlockingRequests<T extends { id: string }>(
  sessionID: string | null,
  directory: string | undefined,
  selectRequestsBySession: (state: State) => Record<string, T[] | undefined>,
  empty: T[],
): T[] {
  const cacheRef = useRef<ScopedBlockingRequestCache<T>>({
    sessionID: null,
    sessions: null,
    requestsBySession: null,
    result: empty,
  })

  return useDirectorySync(
    useCallback((state: State) => {
      const requestsBySession = selectRequestsBySession(state)
      const cache = cacheRef.current
      if (
        cache.sessionID === sessionID
        && cache.sessions === state.session
        && cache.requestsBySession === requestsBySession
      ) {
        return cache.result
      }

      const next = collectScopedBlockingRequests(state.session, requestsBySession, sessionID, empty)
      const result = areRequestArraysReferentiallyEqual(cache.result, next) ? cache.result : next
      cacheRef.current = {
        sessionID,
        sessions: state.session,
        requestsBySession,
        result,
      }
      return result
    }, [empty, selectRequestsBySession, sessionID]),
    directory,
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingQuestions(sessionID: string | null, directory?: string): QuestionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectQuestionRequestsBySession, EMPTY_QUESTION_REQUESTS)
}

export function useParentSession(sessionID: string | null, directory?: string): Session | null {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return null
      const current = state.session.find((s) => s.id === sessionID)
      if (!current?.parentID) return null
      return state.session.find((s) => s.id === current.parentID)
        ?? getAllSyncSessions().find((s) => s.id === current.parentID)
        ?? null
    }, [sessionID]),
    directory,
  )
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return childStores.getChild(directory)?.getState().session.find((session) => session.id === sessionID)
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify()
      })
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  const session = useSession(sessionID, directory)
  return (session as (typeof session & { directory?: string | null }) | undefined)?.directory ?? undefined
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

// Shell-mode bridge messages (single bash tool part parented to a synthetic
// shell-marker user message) are hidden from the timeline and rendered inside
// the user row, so they never go through the live streaming-tail path. Their
// part updates (output chunks, running→completed) must not be suspended, or
// the shell card freezes until the next full snapshot rebuild.
const USER_SHELL_MARKER = "The following tool was executed by the user"

const isSuspendExemptShellBridge = (state: State, info: Message, parts: Part[] | undefined): boolean => {
  if (!parts || parts.length !== 1) return false
  const part = parts[0] as { type?: unknown; tool?: unknown }
  if (part?.type !== "tool" || typeof part.tool !== "string" || part.tool.toLowerCase() !== "bash") return false
  const parentID = (info as { parentID?: unknown }).parentID
  if (typeof parentID !== "string" || parentID.length === 0) return false
  const parentParts = state.part[parentID]
  if (!parentParts) return false
  return parentParts.some((parentPart) => {
    if (parentPart?.type !== "text") return false
    if ((parentPart as { synthetic?: boolean }).synthetic !== true) return false
    const text = (parentPart as { text?: unknown }).text
    return typeof text === "string" && text.trim().startsWith(USER_SHELL_MARKER)
  })
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
        && !isSuspendExemptShellBridge(state, record.info, state.part[record.info.id])
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
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
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
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID

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
    visibleMessages: revertMessageID ? sourceMessages.filter((message) => message.id < revertMessageID) : sourceMessages,
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
      && !isSuspendExemptShellBridge(state, message, state.part[message.id])
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

export function useSessionMessageCount(sessionID: string, directory?: string): number {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return 0
      return state.message[sessionID]?.length ?? 0
    }, [sessionID]),
    directory,
  )
}

export function useSessionRenderable(sessionID: string, directory?: string): boolean {
  const store = useDirectoryStore(directory)
  const renderableRef = useRef(false)
  const getSnapshot = useCallback(() => {
    const renderable = Boolean(sessionID && getSessionMaterializationStatus(store.getState(), sessionID).renderable)
    renderableRef.current = renderable
    return renderable
  }, [sessionID, store])
  const subscribe = useCallback(
    (notify: () => void) => sessionID
      ? subscribeDirectorySessionMessages(store, sessionID, (change) => {
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
      : () => undefined,
    [sessionID, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionTextMessages(sessionID: string, directory?: string): SessionTextMessage[] {
  const records = useSessionMessageRecords(sessionID, directory)

  return useMemo(
    () => records.map((record) => ({
      id: record.info.id,
      role: typeof record.info.role === "string" ? record.info.role : null,
      text: getConcatenatedTextFromParts(record.parts),
    })),
    [records],
  )
}

export function useUserMessageHistory(sessionID: string, directory?: string): string[] {
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
        const records = snapshotRef.current.sessionID === sessionID ? snapshotRef.current.records : []
        const affectsUserHistory = change.partMessageIDs.some((messageID) => (
          records.some((record) => record.message.id === messageID)
        ))
        if (!affectsUserHistory) {
          countSyncPerformance("userMessageHistoryNotificationSkips")
          return
        }
      }
      notify()
    })
    const unsubscribeSession = store.subscribe((state, previous) => {
      if (state.session === previous.session) return
      const currentRevert = state.session.find((session) => session.id === sessionID)?.revert?.messageID
      const previousRevert = previous.session.find((session) => session.id === sessionID)?.revert?.messageID
      if (currentRevert !== previousRevert) notify()
    })
    return () => {
      unsubscribeMessages()
      unsubscribeSession()
    }
  }, [sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

    const state = store.getState()
    const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
    const suspendedPartUpdatesMessageID = options?.suspendPartUpdatesForMessageId ?? undefined
    const reusableSnapshot = getReusableSessionMessageRecordsSnapshot(
      store,
      state,
      sessionID,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    if (reusableSnapshot) {
      snapshotRef.current = reusableSnapshot
      return reusableSnapshot.list
    }

    const previousSnapshot = snapshotRef.current.sessionID === sessionID
      ? snapshotRef.current
      : readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)

    const nextSnapshot = buildSessionMessageRecordsSnapshot(
      state,
      sessionID,
      previousSnapshot,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    snapshotRef.current = nextSnapshot
    rememberSessionMessageRecordsSnapshot(store, nextSnapshot)
    return nextSnapshot.list
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
          const message = snapshot?.byId.get(messageID)?.info
          const previousParts = snapshot?.byId.get(messageID)?.parts
          return Boolean(
            message
            && previousParts
            && !isSuspendExemptShellBridge(state, message, state.part[messageID])
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
      const currentRevert = state.session.find((session) => session.id === sessionID)?.revert?.messageID
      const previousRevert = previous.session.find((session) => session.id === sessionID)?.revert?.messageID
      if (currentRevert !== previousRevert) notify()
    })
    return () => {
      unsubscribeMessages()
      unsubscribeSession()
    }
  }, [options?.enabled, options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Ensures a session's messages are loaded into the sync store.
 * If the session exists in state.session but messages haven't been fetched
 * (state.message[sessionID] is absent), triggers a background API fetch.
 *
 * This covers the case where a user navigates to an old parent session
 * whose child session messages were never loaded — bootstrap only loads
 * session metadata, not messages.
 */

// Module-level in-flight tracking for useEnsureSessionMessages.
// Prevents redundant parallel fetches when multiple component instances
// (e.g. multiple ToolParts) request the same session's messages.
const _ensureMessagesLoading = new Set<string>()

export function useEnsureSessionMessages(sessionID: string, directory?: string) {
  const syncDirectory = useSyncDirectory()
  const resolvedDirectory = directory ?? syncDirectory
  const store = useDirectoryStore(resolvedDirectory)
  const requestGenerationRef = React.useRef(0)

  React.useEffect(() => {
    if (!sessionID) return

    const state = store.getState()
    // Already loaded into a renderable message/part snapshot — nothing to do.
    if (getSessionMaterializationStatus(state, sessionID).renderable) return
    // Session doesn't exist — nothing to load
    if (!state.session.some((s) => s.id === sessionID)) return

    const loadingKey = `${resolvedDirectory}:${sessionID}`
    // Already loading this session for this directory
    if (_ensureMessagesLoading.has(loadingKey)) return

    const generation = ++requestGenerationRef.current
    const isStale = () => generation !== requestGenerationRef.current

    _ensureMessagesLoading.add(loadingKey)

    void (async () => {
      try {
        await materializeSessionFromServer(resolvedDirectory, sessionID, store, { reason: "ensure-session-messages", isStale })
      } catch {
        // Transient failure — next navigation or reconnect will retry
      } finally {
        _ensureMessagesLoading.delete(loadingKey)
      }
    })()
  }, [sessionID, store, resolvedDirectory])
}
const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
