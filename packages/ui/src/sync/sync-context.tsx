/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpenCodeClient } from "@opencode/client"
import { syncEventMessageID, syncEventSessionID, type CatalogKind, type OpenchamberNotification, type SyncEvent } from "@/lib/opencode/events"
import type {
  FormRequest,
  Message,
  Part,
  PermissionRequest,
  Session,
  SessionStatus,
  StructuredError,
} from "@/lib/opencode/model"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isSurfaceAttended } from "@/lib/surfaceAttention"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { reduceGlobalEvent, applyDirectoryEvent, type SessionMaterializationReason } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import {
  ChildStoreManager,
  markDirectorySessionPartChanged,
  subscribeDirectoryPermission,
  subscribeDirectoryForms,
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
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { setActionRefs } from "./session-actions"
import { setSyncRefs, getAllSyncSessions, emitSyncConfigChanged } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { stripSessionDiffSnapshots } from "./sanitize"
import { upsertSessionRecord } from "./session-records"
import {
  applySessionEventToGlobalSessions,
  applySessionEventsToGlobalSessions,
} from "./session-event-router"
import { shouldConsumeBulkArchiveEcho } from "./bulk-archive-echo"
import { applyForkedSession, noteForkedSessionPatched } from "./forked-session"
import { useBtwStore } from "@/stores/useBtwStore"
import { selectNewChildSessions } from "./child-session-discovery"
import { syncDebug } from "./debug"
import { getReconnectCandidateSessionIds, mergeBootstrapSessions } from "./reconnect-recovery"
import { messagesBefore } from "./message-ordering"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useRoutingStore } from "@/stores/useRoutingStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { subscribeMessageQueueSync } from "./message-queue-sync"
import {
  processVSCodePermissionAutoAccept,
  processVSCodeReconciledPermissionAutoAccept,
} from "./vscode-permission-auto-accept"
import { useConfigStore } from "@/stores/useConfigStore"
import { refreshStoresForCatalogKind } from "@/stores/catalogRefresh"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { toast } from "@/components/ui"
import { appendNotification } from "./notification-store"
import { recordSessionError, summarizeOpenCodeError } from "./session-error-log"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  getDirectoryOwnedSessionIds,
  setSessionParentResolver,
  useGlobalSessionStatusStore,
} from "./global-session-status"
import { applyGlobalBlockingRequestEvents } from "./global-blocking-requests"
import type { State } from "./types"
import {
  getSessionMaterializationRequestKey,
  getSessionMaterializationStatus,
  getStaleRunningToolMessageID,
  isSessionMaterializationStillNeeded,
  type SessionMaterializationRequest,
} from "./materialization"
import { openSessionFromToast } from "./session-navigation"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isFilesystemError } from "@/lib/api/files-errors"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import { sessionEvents } from "@/lib/sessionEvents"
import { listGlobalSessionPages, splitGlobalSessionsByArchived, type SessionPageLister } from "@/stores/globalSessions"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests } from "./scoped-blocking-requests"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type TranscriptPrompt, type UserMessageHistorySnapshot } from "./user-message-history"
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

/**
 * The provider's current directory as a subscribable value instead of a
 * context field. A hook that is handed an explicit directory reads a constant
 * snapshot from it and therefore does not re-render when the current
 * directory changes; a context read would re-render every consumer — every
 * sidebar row — on each cross-project switch.
 */
type CurrentDirectorySource = {
  get: () => string
  subscribe: (notify: () => void) => () => void
}

type SyncRuntime = {
  childStores: ChildStoreManager
  messageLoader: SessionMessageLoader
  runtimeKey: string
  sdk: OpenCodeClient
  currentDirectory: CurrentDirectorySource
}

type SyncSystem = SyncRuntime & {
  directory: string
}

// Subagent sessions keep their parent's turn open in the status index; the
// global sessions list knows every session's parent, children included.
setSessionParentResolver((sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId)?.parentID)

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
const SYNC_RUNTIME_CONTEXT_GLOBAL_KEY = "__openchamber_sync_runtime_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
  [SYNC_RUNTIME_CONTEXT_GLOBAL_KEY]?: React.Context<SyncRuntime | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext
const SyncRuntimeContext = syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] ?? createContext<SyncRuntime | null>(null)
syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] = SyncRuntimeContext

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

export function useSyncRuntime() {
  const ctx = useContext(SyncRuntimeContext)
  if (!ctx) throw new Error("useSyncRuntime must be used within <SyncProvider>")
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
  const { childStores } = useSyncRuntime()
  const sourceRevisionRef = useRef(0)
  const cacheRef = useRef<{
    childStores: ChildStoreManager
    selector: (states: State[]) => T
    revision: number
    value: T
  } | null>(null)

  const getSnapshot = useCallback(() => {
    const cached = cacheRef.current
    if (
      cached
      && cached.childStores === childStores
      && cached.selector === selector
      && cached.revision === sourceRevisionRef.current
    ) {
      return cached.value
    }
    const next = selector(getLiveStates(childStores))
    const value = cached && isEqual(cached.value, next) ? cached.value : next
    cacheRef.current = { childStores, selector, revision: sourceRevisionRef.current, value }
    return value
  }, [childStores, isEqual, selector])

  const subscribeToSource = useCallback((notify: () => void) => {
    const invalidate = () => {
      sourceRevisionRef.current += 1
      notify()
    }
    // Force the post-subscribe snapshot to close the read-before-subscribe gap.
    sourceRevisionRef.current += 1
    return subscribe ? subscribe(childStores, invalidate) : childStores.subscribeAll(invalidate)
  }, [childStores, subscribe])

  return React.useSyncExternalStore(
    subscribeToSource,
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
  globalSessionEvents: SyncEvent[]
  globalStatusEventsByDirectory: Map<string, SyncEvent[]>
}

const createDirectoryEventBatch = (): DirectoryEventBatch => ({
  states: new Map(),
  clonedFields: new Map(),
  changedStores: new Set(),
  globalSessionEvents: [],
  globalStatusEventsByDirectory: new Map(),
})

const getDirectoryEventState = (
  store: StoreApi<DirectoryStore>,
  batch?: DirectoryEventBatch,
): DirectoryStore => batch?.states.get(store) ?? store.getState()

const publishDirectoryEventBatch = (batch: DirectoryEventBatch): void => {
  applySessionEventsToGlobalSessions(batch.globalSessionEvents)
  for (const [directory, events] of batch.globalStatusEventsByDirectory) {
    applyGlobalSessionStatusEvents(directory, events)
    applyGlobalBlockingRequestEvents(directory, events)
  }
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
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      return aggregateLiveSessions(states)
    }, []),
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

// Active-session watchdog network calls run under the shared
// background-network gate (see lib/background-network.ts). The watchdog walks
// every initialized child store each tick and fires a status poll plus a
// child-session discovery list per directory with active candidates — on
// startup with many cache-hydrated directories that is dozens of simultaneous
// requests, which would otherwise queue interactive traffic (opening a
// session) behind them on the browser's ~6 sockets per origin. Later ticks
// still cover every directory via the per-directory timestamps.

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

// One in-flight directory status fetch at a time, shared by the active-session
// watchdog poll and the deferred completion poll so the two cannot overlap on
// the same directory.
const statusPollingDirectories = new Set<string>()

// Directories with a child-session discovery pull in flight. Discovery now
// pages through the session list, so one pull can outlast the watchdog
// interval; two overlapping pulls would each snapshot the same pre-commit
// session list and append the same child twice.
const childDiscoveryDirectories = new Set<string>()

// Deferred completion polls awaiting their delay, keyed by directory+session so
// a burst of completing messages schedules one check.
const pendingMessageCompletionPolls = new Map<string, ReturnType<typeof setTimeout>>()

// How long to wait for the turn's own `session.idle` before spending a request.
export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750

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
  if (existing && Date.now() - existing.enqueuedAt < SESSION_MATERIALIZATION_COOLDOWN_MS) {
    const settlementMustFollowEarlierRecovery = request.reason === "settled-running-tool"
      && existing.request.reason !== "settled-running-tool"
    if (!settlementMustFollowEarlierRecovery) return
  }

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
      await materializeSessionFromServer(directory, sessionID, store, {
        ...request,
        isStale: () => childStores.children.get(directory) !== store
          || pendingSessionMaterializations.get(k) !== pending,
      })
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
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const isStale = () => options?.isStale?.() || getRuntimeKey() !== runtimeKey
    || opencodeClient.getSdkClient() !== sdk
  const statusBeforeMaterialization = store.getState().session_status?.[sessionID]
  syncDebug.recovery.materializing({
    reason: options?.reason ?? "ensure-session-messages",
    directory,
    sessionID,
    messageID: options?.messageID,
    partID: options?.partID,
  })
  const loader = getImperativeSessionMessageLoader()
  if (!loader || isStale()) return
  await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
  if (isStale()) return
  if (loader.getSnapshot({ directory, sessionID }).status === "error") {
    throw loader.getSnapshot({ directory, sessionID }).error ?? new Error("Session materialization failed")
  }

  if (statusBeforeMaterialization && statusBeforeMaterialization.type !== "idle" && !isStale()) {
    await resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative", isStale)
  }
  if (!isStale()) {
    await recoverInterruptedTurnAfterMessageLoad(directory, store, sessionID, isStale)
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
/**
 * The session id OpenCode gives a form no session owns: an MCP elicitation is
 * raised by a server of the whole location (directory), not by a turn. See
 * `GLOBAL_ELICITATION_SESSION_ID` in OpenCode's `packages/core/src/mcp/index.ts`.
 * Replies go to `/session/global/form/:id`, so the sentinel is kept as-is.
 */
export const LOCATION_SCOPED_FORM_SESSION_ID = "global"

const pendingFormToastIds = new Set<string>()
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

const getFormToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

/** A pending form has no question text on the wire — only the form's title. */
const FORM_TOAST_DESCRIPTION = "Agent is waiting for your input"

/** A location-scoped form names no session to open; the toast then only announces it. */
const formToastAction = (sessionID: string, directory: string) => (
  sessionID === LOCATION_SCOPED_FORM_SESSION_ID
    ? undefined
    : { label: "Open session", onClick: () => openSessionFromToast(sessionID, directory) }
)

/** Blank server strings mean "absent" here, not "empty title". */
const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * OpenChamber's own notification frame: the agent-completion notice for
 * desktop, VS Code and mobile (the web surface has its own stream), plus the
 * toast raised when a managed OpenCode restart interrupted a turn.
 */
const handleUiNotificationEvent = (notification: OpenchamberNotification, fallbackDirectory: string): void => {
  const kind = trimmedOrUndefined(notification.kind)
  const sessionId = trimmedOrUndefined(notification.sessionId)
  const directory = trimmedOrUndefined(notification.directory)
    ?? (fallbackDirectory !== "global" ? fallbackDirectory : "")

  if (kind === "opencode-restart-interrupted") {
    const dictionary = useI18nStore.getState().dictionary
    const title = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.title")
    const options = {
      id: "opencode-restart-interrupted",
      description: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.description"),
      duration: Infinity,
    }
    if (sessionId && directory) {
      toast.info(title, {
        ...options,
        action: {
          label: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.openSession"),
          onClick: () => openSessionFromToast(sessionId, directory),
        },
      })
    } else {
      toast.info(title, options)
    }
  }

  // The local desktop shell already delivered this one natively.
  if (
    (notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true)
    && getRuntimeKey() === "local"
  ) return

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) return

  void notifications.notifyAgentCompletion({
    title: trimmedOrUndefined(notification.title),
    body: trimmedOrUndefined(notification.body),
    tag: trimmedOrUndefined(notification.tag),
    kind,
    sessionId,
    directory: directory || undefined,
    requireHidden: notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })
}

export function setActiveSession(directory: string, sessionId: string) {
  const previousDirectory = _activeDirectory
  _activeDirectory = directory
  _activeSession = sessionId
  getImperativeSessionMessageLoader()?.scheduleCacheRetention(previousDirectory)
  getImperativeSessionMessageLoader()?.touchSessionCache({ directory, sessionID: sessionId })
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    getImperativeSessionMessageLoader()?.scheduleCacheRetention(directory)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  // A location-scoped form is docked in whichever session of its directory is
  // open, so looking at any session there is looking at the form.
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) {
    return Boolean(_activeDirectory && _activeSession && directory === _activeDirectory && isSurfaceAttended())
  }
  if (
    _activeDirectory && _activeSession
    && directory === _activeDirectory && sessionId === _activeSession
    // The user must actually see the surface for the active session to count
    // as "seen": if the app is minimized, in the background, or (in VS Code)
    // the chat view is hidden, a turn finishing in the selected session still
    // raises an unseen marker.
    && isSurfaceAttended()
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

const toSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => status

function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

// How a `/api/session/active` snapshot is reconciled into the store.
//
// The snapshot lists only active (busy/retry) sessions across every
// directory; an absent candidate means "idle per this snapshot".
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
      // Keep the successful snapshot distinguishable from "status has never
      // been observed". Interrupted-turn recovery requires this explicit
      // settle marker after a cold reload.
      if (!existing || existing.type !== "idle") {
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
  isStale?: () => boolean,
): Promise<DirectorySessionStatusSnapshot | null> {
  const nextStatuses = await opencodeClient.getActiveSessionStatuses()
  // null = fetch failed; preserve existing state. {} or populated = a snapshot
  // of active sessions — reconciled per `mode` (absence ≠ idle under monotonic).
  if (nextStatuses === null || isStale?.()) return null
  applySessionStatusSnapshot(store, nextStatuses, candidateSessionIds, mode)
  if (mode === "authoritative") {
    store.setState({ sessionStatusReady: true })
    applyGlobalSessionStatusSnapshot(directory, nextStatuses, getDirectoryOwnedSessionIds(directory, store.getState().session))
    // An authoritative snapshot that settles sessions previously observed
    // busy/retry can leave their trailing assistant message and tool parts
    // unfinished (managed process died mid-turn, #2577): finalize them now.
    // The snapshot write above already lowered their status to explicit idle,
    // which is the gate the helper requires — a session the snapshot reports
    // busy stays untouched.
    for (const sessionId of candidateSessionIds) {
      applyInterruptedTurnReconciliation(store, sessionId)
    }
  }
  return nextStatuses
}

/**
 * Re-check the session status shortly after an assistant message completes.
 * The turn-ending `session.idle` event can be delayed or lost; left alone, the
 * busy spinner keeps showing until the next watchdog poll tick (up to ~5s) and
 * its escalation (up to ~10s).
 *
 * The check is deferred by `MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS`, and the
 * status is read again when the timer fires: a normal turn whose `session.idle`
 * arrives inside that window settles on its own and issues no request at all.
 * Only a session the store still believes busy costs one status fetch, which
 * mirrors the watchdog escalation — the monotonic pass confirms/raises busy but
 * never lowers it, and when the snapshot reports the session idle while the
 * store still believes it busy, an authoritative resync settles the status.
 *
 * Bounded: one scheduled check per session, one in-flight status fetch per
 * directory (shared with the watchdog poll), best-effort — the watchdog poll
 * remains the backstop.
 */
export function maybePollStatusAfterMessageCompletion(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
): void {
  if (!directory || directory === "global" || !sessionID) return
  const current = store.getState().session_status?.[sessionID]
  if (!current || current.type === "idle") return

  const pendingKey = `${directory}\u0000${sessionID}`
  if (pendingMessageCompletionPolls.has(pendingKey)) return

  const timer = setTimeout(() => {
    pendingMessageCompletionPolls.delete(pendingKey)
    const latest = store.getState().session_status?.[sessionID]
    if (!latest || latest.type === "idle") return
    if (statusPollingDirectories.has(directory)) return

    statusPollingDirectories.add(directory)
    void (async () => {
      try {
        const statuses = await runBackgroundNetworkTask(() =>
          resyncDirectorySessionStatuses(directory, store, [sessionID], "monotonic"), "active-session")
        if (!statuses) return
        if (needsSnapshotAfterStatusPoll(store.getState(), sessionID, statuses[sessionID])) {
          await runBackgroundNetworkTask(() =>
            resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative"), "active-session")
        }
      } catch {
        // Best-effort — the watchdog poll retries on its own cadence.
      } finally {
        statusPollingDirectories.delete(directory)
      }
    })()
  }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS)

  pendingMessageCompletionPolls.set(pendingKey, timer)
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

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: SyncEvent) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
}

export const createEventRoutingIndex = (): EventRoutingIndex => ({
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

/** Part-bearing events: the store slice they touch is `part`, keyed by message. */
const isPartEvent = (type: SyncEvent["type"]): boolean => (
  type === "message.part.updated"
  || type === "message.part.delta"
  || type === "message.tool.transition"
  || type === "message.parts.replaced"
)

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

const getActiveDirectoryFallback = (
  childStores: ChildStoreManager,
  sessionID?: string | null,
): string | null => {
  if (!_activeDirectory || !_activeSession) return null
  if (sessionID && sessionID !== _activeSession) return null
  return childStores.getChild(_activeDirectory) ? _activeDirectory : null
}

const resolveCachedSessionDirectory = (sessionID: string): string | null => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionID)
  return session ? resolveGlobalSessionDirectory(session) : null
}

const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  // A location-scoped form names the "global" sentinel, not a session: no
  // store lists it, and indexing it would file the next directory's
  // elicitation into the first one's store. Its own directory tag routes it.
  const addressedSessionID = syncEventSessionID(payload)
  const sessionID = addressedSessionID === LOCATION_SCOPED_FORM_SESSION_ID ? undefined : addressedSessionID
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

    // Unopened directories have no store, so a session the global cache lists
    // for one of them is routed to that recorded directory. Without this, the
    // active-session and single-store fallbacks below would file another
    // project's events into whichever directory happens to be open.
    const cachedDirectory = resolveCachedSessionDirectory(sessionID)
    if (cachedDirectory) {
      return cachedDirectory
    }

    // The global stream does not always include a directory. During a session
    // transition, its routing index can lag the active session briefly; route
    // a session-addressed event only when that session is the one being viewed.
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

/**
 * Re-fetch pending forms and permissions for a directory and merge them
 * into the directory's child store, preserving any in-flight SSE updates that
 * arrived while the request was pending. Used by reconnect/materialization
 * recovery paths only; normal session switches rely on primary SSE reducer
 * state for `form.created` / `permission.asked` events. When
 * `candidateSessionIds` is omitted, every session known to the directory store
 * is treated as a candidate; when provided, recovery is limited to those IDs.
 */
export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean },
) {
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return
  const candidates = Array.from(candidateIds)

  // Re-fetch pending forms that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.form[sessionId])]),
    )
    const pendingForms = await opencodeClient.listPendingForms({ directories: [directory] })
    const grouped: Record<string, FormRequest[]> = {}
    for (const form of pendingForms) {
      if (!form?.id || !form.sessionID) continue
      if (!candidateIds.has(form.sessionID)) continue
      const list = grouped[form.sessionID]
      if (list) list.push(form)
      else grouped[form.sessionID] = [form]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    for (const [sessionId, forms] of Object.entries(grouped)) {
      const knownIds = new Set((before.form[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const form of forms) {
        if (knownIds.has(form.id)) continue
        const toastKey = getFormToastKey(sessionId, form.id)
        if (!toastKey || pendingFormToastIds.has(toastKey)) continue
        pendingFormToastIds.add(toastKey)
        toast.info(form.title, {
          id: `form-${toastKey}`,
          description: FORM_TOAST_DESCRIPTION,
          action: formToastAction(sessionId, directory),
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.form }
      for (const [sessionId, forms] of Object.entries(grouped)) {
        merged[sessionId] = forms
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.form[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { form: merged }
    })
  } catch {
    // Non-fatal: form resync best-effort
  }

  if (options?.includePermissions === false) return

  // Re-fetch pending permissions — same rationale as forms.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!candidateIds.has(permission.sessionID)) continue
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
          if (!(await processVSCodeReconciledPermissionAutoAccept(permission, directory))) return
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

export async function resyncBlockingRequestsForActiveDirectory(
  directory: string,
  childStores: ChildStoreManager,
) {
  const store = childStores.getChild(directory)
  if (!store) return
  await resyncBlockingRequestsForDirectory(directory, store)
}

async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
  isStale: () => boolean,
) {
  if (isStale()) return
  const current = store.getState()
  const candidateSessionIds = getActiveSessionCandidateIds(directory, current)
  if (candidateSessionIds.length === 0) return

  await resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "authoritative", isStale)
  if (isStale()) return

  await Promise.all(candidateSessionIds.map(async (sessionId) => {
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const loader = getImperativeSessionMessageLoader()
    const [session] = await Promise.all([
      retry(() => opencodeClient.getSession(sessionId, directory)).catch(() => null),
      loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT) ?? Promise.resolve(),
    ])
    if (isStale()) return
    await recoverInterruptedTurnAfterMessageLoad(directory, store, sessionId, isStale)
    if (isStale()) return
    if (!session) return

    const nextSession = stripSessionDiffSnapshots(session)
    store.setState((state: DirectoryStore) => {
      const sessions = upsertSessionRecord(state.session, nextSession)
      let sessionTotal = state.sessionTotal

      if (sessions === state.session) {
        return state
      }
      if (!state.session.some((item) => item.id === nextSession.id) && !nextSession.parentID) sessionTotal += 1

      return {
        session: sessions,
        sessionTotal,
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, store.getState().message[sessionId] ?? [])
  }))

  if (isStale()) return
  await resyncBlockingRequestsForDirectory(directory, store, candidateSessionIds)

  if (isStale()) return
  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

/**
 * OpenCode reports a catalog change (`config.updated`, `agent.updated`, ...)
 * without saying what changed, so the affected slice is re-read rather than
 * patched. Agents, commands, config and providers resolve per directory, so
 * every open directory refreshes its own copy; projects are global.
 *
 * The sync stores only hold what chat needs; the Settings lists and the
 * composer read their own stores, which `refreshStoresForCatalogKind` re-reads
 * for the same kind.
 */
async function reloadCatalog(kind: CatalogKind, childStores: ChildStoreManager): Promise<void> {
  // Before anything re-reads: a fresh GET must not be served the config the
  // client cached seconds ago.
  if (kind === "config") opencodeClient.clearConfigCache()

  void refreshStoresForCatalogKind(kind)

  if (kind === "project") {
    const projects = await opencodeClient.listProjects().catch(() => null)
    if (projects) useGlobalSyncStore.getState().actions.set({ projects })
    return
  }
  // No sync-store slice of their own: their consumers read them on demand.
  if (kind === "skill" || kind === "plugin" || kind === "websearch") return

  await Promise.all([...childStores.children.entries()].map(async ([directory, store]) => {
    try {
      if (kind === "agent") {
        store.setState({ agent: await opencodeClient.listAgents(directory) })
      } else if (kind !== "command") {
        // Commands have no sync-store slice: `refreshStoresForCatalogKind`
        // re-reads `useCommandsStore`, the only consumer, on demand.
        if (kind === "config") {
          const config = await opencodeClient.getConfig(directory)
          store.setState({ config })
          emitSyncConfigChanged(directory, config)
        }
        // The provider slice follows everything that can change it:
        // `provider.updated` / `model.updated` (2.0.8's own announcements), a
        // credential change, and the config (which can declare providers).
        const provider = await opencodeClient.getProvidersForConfig(directory)
        // Same catalog, same object: a re-read that changes nothing must not
        // re-render every provider consumer.
        if (JSON.stringify(store.getState().provider) !== JSON.stringify(provider)) {
          store.setState({ provider })
        }
      }
    } catch {
      // Best-effort: the next catalog event or bootstrap re-reads it.
    }
  }))
}

/**
 * One saved file makes v2 rebuild several catalogs, so the events arrive in a
 * burst. Collect the kinds and re-read each one once the burst settles; the
 * lists are whole-slice reads, so a later event supersedes an earlier one of
 * the same kind anyway.
 */
const CATALOG_RELOAD_DEBOUNCE_MS = 250
const pendingCatalogKinds = new Set<CatalogKind>()
let catalogReloadTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCatalogReload(kind: CatalogKind, childStores: ChildStoreManager): void {
  pendingCatalogKinds.add(kind)
  if (catalogReloadTimer) clearTimeout(catalogReloadTimer)
  catalogReloadTimer = setTimeout(() => {
    catalogReloadTimer = null
    const kinds = [...pendingCatalogKinds]
    pendingCatalogKinds.clear()
    for (const pending of kinds) void reloadCatalog(pending, childStores)
  }, CATALOG_RELOAD_DEBOUNCE_MS)
}

// Only top-level sessions raise notifications. The directory store knows the
// parent when the directory is open; the global cache covers the rest.
const isSubtaskSession = (
  sessionID: string,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  const stored = store ? getDirectoryEventState(store, batch).session.find((s) => s.id === sessionID) : undefined
  const session = stored ?? useGlobalSessionsStore.getState().entityById.get(sessionID)
  return Boolean(session?.parentID)
}

const notifyPermissionAsked = (permission: PermissionRequest, directory: string): void => {
  showPermissionNeededToast({
    permission,
    directory,
    isViewed: isViewedInCurrentSession(directory, permission.sessionID),
    pendingIds: pendingPermissionToastIds,
    show: (title, options) => toast.info(title, options),
    openSession: openSessionFromToast,
  })
}

const notifyFormCreated = (form: FormRequest, directory: string): void => {
  const sessionID = form.sessionID
  const toastKey = getFormToastKey(sessionID, form.id)
  if (isViewedInCurrentSession(directory, sessionID) || !toastKey || pendingFormToastIds.has(toastKey)) return
  pendingFormToastIds.add(toastKey)
  toast.info(form.title, {
    id: `form-${toastKey}`,
    description: FORM_TOAST_DESCRIPTION,
    action: formToastAction(sessionID, directory),
  })
}

// Blocking requests in a directory without a store still deserve the in-app
// toast: the sidebar row and tray approvals need the directory store, but the
// toast only needs the request and where to open it. VS Code keeps its
// extension-host auto-accept path, which runs on the store branch only.
const notifyBlockingRequestWithoutStore = (payload: SyncEvent, directory: string): void => {
  if (isVSCodeRuntime()) return
  if (payload.type === "permission.asked") {
    const permission = payload.properties
    if (usePermissionStore.getState().isSessionAutoAccepting(permission.sessionID)) return
    notifyPermissionAsked(permission, directory)
    return
  }
  if (payload.type === "form.created") {
    notifyFormCreated(payload.properties.form, directory)
  }
}

const recordTurnOutcomeNotification = (
  payload: Extract<SyncEvent, { type: "session.idle" | "session.error" }>,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): void => {
  const { sessionID } = payload.properties
  if (!sessionID) return
  const errorSummary = payload.type === "session.error" ? summarizeOpenCodeError(payload.properties.error) : null
  if (errorSummary) {
    recordSessionError({ sessionId: sessionID, directory, ...errorSummary })
  }
  if (isSubtaskSession(sessionID, directory, childStores, batch)) return
  appendNotification({
    directory,
    session: sessionID,
    time: Date.now(),
    viewed: isViewedInCurrentSession(directory, sessionID),
    ...(errorSummary
      ? { type: "error" as const, error: errorSummary }
      : { type: "turn-complete" as const }),
  })
}

export function handleEvent(
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  skipVSCodeAutoAccept = false,
  streamingDirectory?: string,
  batch?: DirectoryEventBatch,
  globalEffectsAlreadyApplied = false,
) {
  if (payload.type === "openchamber.notification") {
    handleUiNotificationEvent(payload.properties, normalizeEventDirectory(rawDirectory))
    return
  }

  if (payload.type === "openchamber.permission-auto-accept") {
    const { sessions, revision } = payload.properties
    usePermissionStore.getState().applySnapshot({ sessions, revision }, expectedRuntimeKey)
    return
  }

  if (shouldConsumeBulkArchiveEcho(payload, expectedRuntimeKey)) return

  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores, batch)

  // OpenCode dropped this directory's in-memory services (an hour idle, or an
  // explicit reload). Session records and messages live in its database and
  // stay valid; what went away is the live state read from that graph, so the
  // directory the user is looking at is bootstrapped again from scratch. The
  // pending permissions and forms it rejected on the way out, and the turns it
  // interrupted, arrive as their own events. Background directories are left
  // alone on purpose: re-reading them would recreate the services OpenCode
  // just evicted and turn every idle directory into an hourly refresh loop;
  // they are re-read when selected or on the next reconnect.
  if (payload.type === "location.shutdown") {
    if (
      directory
      && directory !== "global"
      && expectedRuntimeKey === getRuntimeKey()
      && directory === opencodeClient.getDirectory()
      && childStores.getChild(directory)
    ) {
      childStores.requestBootstrap({ directory, priority: "selected", reason: "location-shutdown", force: true })
    }
    return
  }

  if (payload.type === "session.patched") {
    noteForkedSessionPatched(payload.properties.sessionID)
  }

  if (payload.type === "session.forked") {
    void applyForkedSession(
      {
        sessionID: payload.properties.sessionID,
        parentID: payload.properties.parentID,
        directory: directory && directory !== "global" ? directory : undefined,
      },
      {
        isKnown: (sessionID) => useGlobalSessionsStore.getState().entityById.has(sessionID),
        isCreatingLocally: (parentID) => useBtwStore.getState().byParent[parentID]?.creating === true,
        getSession: (sessionID, sessionDirectory) => opencodeClient.getSession(sessionID, sessionDirectory),
        isCurrent: () => expectedRuntimeKey === getRuntimeKey(),
        apply: (info) => handleEvent(
          rawDirectory,
          { type: "session.created", properties: { info } },
          childStores,
          routingIndex,
          expectedRuntimeKey,
        ),
      },
    )
    return
  }

  if (payload.type === "session.deleted" && expectedRuntimeKey === getRuntimeKey()) {
    const sessionID = syncEventSessionID(payload)
    if (sessionID && directory && directory !== "global") {
      cleanupPersistedSessionState({ runtimeKey: expectedRuntimeKey, directory, sessionId: sessionID })
    }
  }

  if (!globalEffectsAlreadyApplied) {
    if (batch) {
      batch.globalSessionEvents.push(payload)
      const statusEvents = batch.globalStatusEventsByDirectory.get(directory)
      if (statusEvents) statusEvents.push(payload)
      else batch.globalStatusEventsByDirectory.set(directory, [payload])
    } else {
      applySessionEventToGlobalSessions(payload)
      // Child stores remain the primary source for synced directories; these
      // indexes cover unopened directories and list/status races.
      applyGlobalSessionStatusEvent(directory, payload)
      applyGlobalBlockingRequestEvents(directory, [payload])
    }
  }

  // Turn-complete and error notifications are recorded before the directory
  // store lookup. Unopened directories are never bootstrapped and have no
  // store, yet their collapsed sidebar rows still need the unread dot.
  if ((payload.type === "session.idle" || payload.type === "session.error") && directory && directory !== "global") {
    recordTurnOutcomeNotification(payload, directory, childStores, batch)
  }

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
    } else if (result.type === "catalog") {
      scheduleCatalogReload(result.kind, childStores)
    }
    // On server.connected, re-bootstrap all directories
    // but only if not during recent boot
    if (payload.type === "server.connected") {
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
    const sessionID = syncEventSessionID(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (!store) {
    if (payload.type === "session.revert.committed") {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID: payload.properties.sessionID })
    }
    notifyBlockingRequestWithoutStore(payload, directory)
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "catalog") {
      scheduleCatalogReload(result.kind, childStores)
    }
    return
  }

  childStores.mark(resolvedDirectory)

  if (payload.type === "permission.asked") {
    const permission: PermissionRequest = payload.properties
    if (isVSCodeRuntime() && !skipVSCodeAutoAccept) {
      const eventKey = getVSCodePermissionEventKey(expectedRuntimeKey, resolvedDirectory, permission.sessionID, permission.id)
      const eventToken = Symbol(eventKey ?? permission.id)
      if (eventKey) pendingVSCodePermissionEvents.set(eventKey, eventToken)
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      const completePermissionCheck = (accepted: boolean) => {
        if (eventKey && pendingVSCodePermissionEvents.get(eventKey) !== eventToken) return
        if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
        if (expectedRuntimeKey !== getRuntimeKey()) return
        if (!accepted) handleEvent(
          rawDirectory,
          payload,
          childStores,
          routingIndex,
          expectedRuntimeKey,
          true,
          streamingDirectory,
          undefined,
          true,
        )
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

    notifyPermissionAsked(permission, resolvedDirectory)
  }

  if (payload.type === "permission.replied") {
    const { sessionID, requestID } = payload.properties
    // A request the routing safety net was holding is settled either way.
    if (requestID) useRoutingStore.getState().releasePermission(requestID)
    const toastKey = getPermissionToastKey(sessionID, requestID)
    const eventKey = getVSCodePermissionEventKey(expectedRuntimeKey, resolvedDirectory, sessionID, requestID)
    if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
    if (toastKey) {
      pendingPermissionToastIds.delete(toastKey)
      toast.dismiss(`permission-${toastKey}`)
    }
  }

  if (payload.type === "form.created") {
    notifyFormCreated(payload.properties.form, resolvedDirectory)
  }

  if (payload.type === "form.settled") {
    const { sessionID, formID } = payload.properties
    const toastKey = getFormToastKey(sessionID, formID)
    if (toastKey) {
      pendingFormToastIds.delete(toastKey)
      toast.dismiss(`form-${toastKey}`)
    }
  }

  // Sync-layer parent resync: when a child session goes idle, recover
  // the parent session snapshot. This ensures the
  // parent's task tool part reflects the child's completion even when
  // no ToolPart component is mounted.
  if (payload.type === "session.idle") {
    const idleSessionId = payload.properties.sessionID
    if (idleSessionId && resolvedDirectory && resolvedDirectory !== "global") {
      const sessionState = getDirectoryEventState(store, batch)
      const parentID = sessionState.session.find((s) => s.id === idleSessionId)?.parentID
      if (parentID) {
        enqueueSessionMaterialization(resolvedDirectory, parentID, childStores, { reason: "child-session-idle" })
      }
    }
  }

  // Read live state, create targeted draft cloning ONLY fields that event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = getDirectoryEventState(store, batch)
  // OpenCode v2 settles a live tool through `message.tool.transition`; a full
  // `message.part.updated` arrives only for snapshots. Both can finish a tool.
  const toolPartRef = payload.type === "message.part.updated"
    ? { messageID: payload.properties.part.messageID, partID: payload.properties.part.id }
    : payload.type === "message.tool.transition"
      ? { messageID: payload.properties.messageID, partID: payload.properties.partID }
      : undefined
  const previousPart = toolPartRef
    ? current.part[toolPartRef.messageID]?.find((part) => part.id === toolPartRef.partID)
    : undefined
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
    case "session.patched":
    case "session.deleted":
      cloneField("session", (value) => [...value])
      cloneField("permission", (value) => ({ ...value }))
      cloneField("form", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      cloneField("sessionEventRevision", (value) => ({ ...(value ?? {}) }))
      cloneField("sessionDeletedRevision", (value) => ({ ...(value ?? {}) }))
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("session_status", (value) => ({ ...(value ?? {}) }))
      break
    case "message.updated":
    case "message.patched":
      cloneField("message", (value) => ({ ...value }))
      break
    case "message.removed":
      cloneField("message", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      break
    case "session.revert.committed":
      cloneField("session", (value) => [...value])
      cloneField("message", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      break
    case "message.part.updated":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      cloneField("part", (value) => ({ ...value }))
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("permission", (value) => ({ ...value }))
      break
    case "form.created":
    case "form.settled":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("form", (value) => ({ ...value }))
      break
    default:
      break
  }

  countSyncPerformance("reducerEvents")
  const reducerResult = applyDirectoryEvent(draft, payload)
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization
  // Retire old reads even if a local send already removed the reverted range.
  // Only optimistic messages surviving the reducer may enter the next fetch.
  if (payload.type === "session.revert.committed") {
    const { sessionID } = payload.properties
    getImperativeSessionMessageLoader()?.invalidateSession(
      { directory: resolvedDirectory, sessionID }, draft.message[sessionID] ?? [],
    )
  }
  if (reducerChanged && (payload.type === "session.patched" || payload.type === "session.deleted")) {
    recordDirectoryRecoveryEvent(store, payload)
  }

  const updatedPart = reducerChanged && toolPartRef
    ? draft.part[toolPartRef.messageID]?.find((part) => part.id === toolPartRef.partID)
    : undefined
  if (updatedPart) {
    sessionEvents.requestGitRefreshForToolTransition(resolvedDirectory, previousPart, updatedPart)
  }

  if (reducerChanged) {
    countSyncPerformance("reducerChangedEvents")
    const eventSessionID = syncEventSessionID(payload)
    const eventMessageID = syncEventMessageID(payload)
    if (isPartEvent(payload.type) && eventMessageID) {
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
      isPartEvent(payload.type)
      && normalizeEventDirectory(resolvedDirectory) === normalizeEventDirectory(streamingDirectory ?? "")
    ) {
      const heartbeatSessionID = sessionID ?? (messageID ? routingIndex.messageSessionById.get(messageID) : undefined)
      if (heartbeatSessionID) touchStreamingSession(heartbeatSessionID)
    }
    const archived = payload.type === "session.patched"
      && Boolean(payload.properties.patch.time?.archived)
    if (sessionID && (payload.type === "session.deleted" || archived)) {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID })
    }
    syncDebug.dispatch.eventApplied(payload.type, sessionID, messageID)

    // Snapshot materialization on message.updated: if the message was inserted or
    // replaced but draft.part[messageID] is empty, the parts were lost or
    // never arrived. Recover the session so the UI doesn't render a blank bubble.
    if (sessionID && messageID && payload.type === "message.updated") {
      const after = getDirectoryEventState(store, batch)
      const { info } = payload.properties
      if (info.role === "assistant" && !Object.prototype.hasOwnProperty.call(after.part, messageID)) {
        enqueueSessionMaterialization(resolvedDirectory, sessionID, childStores, {
          reason: "empty-assistant-message",
          messageID,
        })
      }
      // An assistant message that finished is strong evidence the turn may
      // have ended; if the session.idle event was delayed or lost, settle the
      // busy status immediately instead of waiting for the next watchdog poll.
      if (info.role === "assistant" && typeof info.time.completed === "number") {
        maybePollStatusAfterMessageCompletion(resolvedDirectory, store, sessionID)
      }
    }
  } else {
    const sessionID = syncEventSessionID(payload)
    const messageID = syncEventMessageID(payload)
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

  // Snapshot materialization is driven by typed reducer outcomes, not by
  // inferring meaning from a generic false/no-change result.
  if (materializationResult) {
    const materializationSessionID = resolveMaterializationSessionID(
      materializationResult.sessionID ?? syncEventSessionID(payload),
      materializationResult.messageID ?? syncEventMessageID(payload),
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

  if (payload.type === "session.idle" || payload.type === "session.error") {
    const sessionID = syncEventSessionID(payload)
    const state = getDirectoryEventState(store, batch)
    const messageID = sessionID ? getStaleRunningToolMessageID(state, sessionID) : undefined
    if (sessionID && messageID) {
      enqueueSessionMaterialization(resolvedDirectory, sessionID, childStores, {
        reason: "settled-running-tool",
        messageID,
      })
    }
    // The reducer already wrote the idle/error status into `draft`; finalize
    // the interrupted message and orphaned tools through the same batch.
    if (sessionID) {
      const interrupted = interruptedTurnToolParts(state, sessionID)
      if (interrupted) {
        cloneField("message", (value) => ({ ...value }))
        draft.message[sessionID] = interrupted.messages
        if (interrupted.parts) {
          cloneField("part", (value) => ({ ...(value ?? {}) }))
          draft.part[interrupted.messageID] = interrupted.parts
        }
        if (batch) {
          batch.states.set(store, draft as DirectoryStore)
          batch.changedStores.add(store)
        } else {
          const currentState = store.getState()
          if (interrupted.parts) {
            store.setState({
              message: { ...currentState.message, [sessionID]: interrupted.messages },
              part: { ...currentState.part, [interrupted.messageID]: interrupted.parts },
            })
          } else {
            store.setState({
              message: { ...currentState.message, [sessionID]: interrupted.messages },
            })
          }
        }
      }
    }
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
}

// ---------------------------------------------------------------------------
// Interrupted-turn reconciliation
//
// A managed OpenCode process can die mid-turn (crash, health-check restart).
// The persisted turn then never settles: the trailing assistant message has
// no `time.completed`, and any tool parts can stay `pending`/`running`
// forever — the server never finalizes them (anomalyco/opencode#19023). The
// settle-triggered tail refresh above refetches the same stale records, so
// the UI would keep the assistant message unfinished and any tool timers and
// "working" styling active indefinitely (#2577).
//
// OpenCode keeps a turn's session busy while it is genuinely alive —
// including while waiting for a form/permission reply — so once a
// session is AUTHORITATIVELY settled (a `session.idle`/`session.error`
// event, or an authoritative status snapshot that lowers a previously busy
// session) and the trailing assistant message is still unfinished with
// no pending form/permission, the turn is definitively interrupted.
// Complete the assistant message locally with an aborted error and finalize
// any orphaned parts as `error`/`Interrupted` with an end time — the same shape
// OpenCode itself writes for cancelled tools. A later terminal event can
// supersede the mark; a stale refresh cannot regress the locally final state.
export function interruptedTurnToolParts(
  state: DirectoryStore,
  sessionID: string,
  now = Date.now(),
): { messageID: string; messages: Message[]; parts?: Part[] } | null {
  if ((state.form?.[sessionID] ?? []).length > 0) return null
  if ((state.permission?.[sessionID] ?? []).length > 0) return null

  const status = state.session_status?.[sessionID]
  if (!status || status.type !== "idle") {
    // Absent status is "unknown", not settled (the reducer maps both
    // session.idle and session.error to {type:"idle"}): never judge an
    // interrupted turn without an authoritative settle signal.
    return null
  }

  const messages = state.message[sessionID] ?? []
  let messageIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role === "user") return null
    if (candidate.role !== "assistant") continue
    messageIndex = index
    break
  }
  if (messageIndex < 0) return null

  const message = messages[messageIndex]
  if (message.role !== "assistant") return null
  if (message.time.completed !== undefined) {
    // The turn finished; a missed terminal tool event is the tail refresh's
    // job, not an interruption.
    return null
  }

  const messageID = message.id
  const nextMessages = [...messages]
  // `materializeSessionSnapshots` supersedes a locally aborted message only
  // when it recognises this exact type, so both sides use the domain value.
  const error: StructuredError = { type: "aborted", message: "aborted" }
  nextMessages[messageIndex] = {
    ...message,
    time: { ...message.time, completed: now },
    error,
  }

  let partsChanged = false
  const currentParts = state.part[messageID]
  const nextParts = currentParts?.map((part) => {
    if (part.type !== "tool") return part
    if (part.state.status !== "pending" && part.state.status !== "running") return part
    partsChanged = true
    const start = part.state.status === "running" ? part.state.time.start : now
    return {
      ...part,
      state: {
        ...part.state,
        status: "error" as const,
        error: "Interrupted",
        time: { start, end: now },
      },
    }
  })

  return {
    messageID,
    messages: nextMessages,
    parts: partsChanged ? nextParts : undefined,
  }
}

function hasUnfinishedAssistantTurn(state: DirectoryStore, sessionID: string): boolean {
  const messages = state.message[sessionID] ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return false
    if (message.role !== "assistant") continue
    return message.time.completed === undefined
  }
  return false
}

function applyInterruptedTurnReconciliation(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const interrupted = interruptedTurnToolParts(store.getState(), sessionID)
  if (!interrupted) return

  const interruptedParts = interrupted.parts
  if (!interruptedParts) {
    store.setState((state) => ({
      message: { ...state.message, [sessionID]: interrupted.messages },
    }))
    return
  }

  store.setState((state) => ({
    message: { ...state.message, [sessionID]: interrupted.messages },
    part: { ...state.part, [interrupted.messageID]: interruptedParts },
  }))
}

/**
 * Re-checks a hydrated session whose trailing assistant turn is unfinished.
 * A cold reload can hydrate messages after the initial status snapshot, so the
 * settle decision must be repeated after the message records are available.
 * If no per-session status exists yet, fetch one authoritative snapshot first;
 * a successful snapshot that omits the session establishes it as idle.
 */
export async function recoverInterruptedTurnAfterMessageLoad(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  isStale?: () => boolean,
): Promise<void> {
  if (isStale?.()) return
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const initial = store.getState()
  if (!hasUnfinishedAssistantTurn(initial, sessionID)) return
  if ((initial.form?.[sessionID] ?? []).length > 0) return
  if ((initial.permission?.[sessionID] ?? []).length > 0) return

  if (!initial.session_status?.[sessionID]) {
    const snapshot = await opencodeClient.getActiveSessionStatuses()
    if (snapshot === null || isStale?.()
      || getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk) return

    // Do not overwrite a live status event that arrived while the snapshot was
    // in flight. The snapshot only fills the previously unknown state.
    if (!store.getState().session_status?.[sessionID]) {
      applySessionStatusSnapshot(store, snapshot, [sessionID], "authoritative")
      applyGlobalSessionStatusSnapshot(directory, snapshot, [sessionID])
    }
  }

  // The messages were read before the status. A turn that finished between
  // the two reads leaves an open assistant message beside an idle status,
  // which is exactly what an interrupted turn looks like, while the completion
  // event may still sit in the pipeline's flush frame. Re-read the tail once
  // under the settled status before judging the turn.
  if (
    store.getState().session_status?.[sessionID]?.type === "idle"
    && hasUnfinishedAssistantTurn(store.getState(), sessionID)
  ) {
    const loader = getImperativeSessionMessageLoader()
    if (loader) {
      await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
      if (isStale?.() || getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk) return
    }
  }

  applyInterruptedTurnReconciliation(store, sessionID)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** One session-list page through the shared client wrapper. */
const listSessionPage: SessionPageLister = (options) => opencodeClient.listSessionsPage(options)

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

export function SyncProvider(props: {
  sdk: OpenCodeClient
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
      sdk: opencodeClient,
      runtimeKey,
    })
  }
  const messageLoader = messageLoaderRef.current
  const messageLoaderDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  messageLoader.configure({ sdk: opencodeClient, runtimeKey })
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const currentDirectoryRef = useRef(props.directory)
  currentDirectoryRef.current = props.directory
  // Written during render (above) so children rendering in the same pass read
  // the new directory; subscribers are notified after commit.
  const currentDirectoryListenersRef = useRef(new Set<() => void>())
  const currentDirectorySource = useMemo<CurrentDirectorySource>(() => ({
    get: () => currentDirectoryRef.current,
    subscribe: (notify) => {
      currentDirectoryListenersRef.current.add(notify)
      return () => currentDirectoryListenersRef.current.delete(notify)
    },
  }), [])
  React.useLayoutEffect(() => {
    for (const notify of currentDirectoryListenersRef.current) notify()
  }, [props.directory])
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const lastChildDiscoveryAtByDirectoryRef = useRef(new Map<string, number>())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const blockingRequestResyncingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)

  const runtime = useMemo<SyncRuntime>(
    () => ({ childStores, messageLoader, runtimeKey, sdk: props.sdk, currentDirectory: currentDirectorySource }),
    [childStores, currentDirectorySource, messageLoader, props.sdk, runtimeKey],
  )
  const system = useMemo<SyncSystem>(
    () => ({ ...runtime, directory: props.directory }),
    [props.directory, runtime],
  )

  const triggerDirectoryResync = useCallback((directory: string, reason: SessionMaterializationReason) => {
    const store = childStores.children.get(directory)
    if (!store) return
    const resyncing = resyncingDirectoriesRef.current
    if (resyncing.has(directory)) return

    lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    resyncing.add(directory)
    const sdk = opencodeClient.getSdkClient()
    const expectedRuntimeKey = getRuntimeKey()
    const isStale = () => getRuntimeKey() !== expectedRuntimeKey
      || opencodeClient.getSdkClient() !== sdk || childStores.children.get(directory) !== store
    void resyncDirectoryAfterReconnect(directory, store, routingIndex, reason, isStale)
      .catch(() => {
        // Transient failure — the watchdog, next SSE event, or reconnect will catch up.
      })
      .finally(() => {
        resyncing.delete(directory)
      })
  }, [childStores, routingIndex])

  useEffect(() => {
    if (typeof window === "undefined") return

    const onSystemResume = () => {
      const directory = currentDirectoryRef.current
      if (!directory || !childStores.getChild(directory)) return

      const resyncing = blockingRequestResyncingDirectoriesRef.current
      if (resyncing.has(directory)) return
      resyncing.add(directory)
      void resyncBlockingRequestsForActiveDirectory(directory, childStores)
        .finally(() => resyncing.delete(directory))
    }

    window.addEventListener("openchamber:system-resume", onSystemResume)
    return () => window.removeEventListener("openchamber:system-resume", onSystemResume)
  }, [childStores])

  // Configure child store manager
  useEffect(() => {
    void usePermissionStore.getState().hydrate().catch(() => undefined)
    void useMessageQueueStore.getState().hydrate().catch(() => undefined)
  }, [props.sdk])

  useEffect(() => {
    const expectedRuntimeKey = getRuntimeKey()
    const sdkEpoch = opencodeClient.getSdkClient()
    return childStores.configure({
      bootstrapConcurrency: 2,
      isCurrentScope: () => getRuntimeKey() === expectedRuntimeKey && opencodeClient.getSdkClient() === sdkEpoch,
      onBootstrap: async (context: DirectoryBootstrapContext) => {
        const { directory } = context
        const isCurrent = context.isCurrent
        const store = childStores.getChild(directory)
        if (!store || !isCurrent()) return

        const failBootstrap = async () => {
          if (!isCurrent()) return
          // Only the owning filesystem API can establish an OS permission
          // failure; OpenCode/proxy text is not permission evidence.
          const files = getRegisteredRuntimeAPIs()?.files
          if (files) {
            try {
              await files.listDirectory(directory)
            } catch (error) {
              if (isFilesystemError(error) && error.reason === "os-permission") throw error
            }
          }
          throw new Error(`Directory bootstrap failed for ${directory}`)
        }
        let initializationAttempt = 0

        const runBootstrap = async (attempt: number): Promise<"complete" | "failed" | "stale"> => {
          if (!isCurrent()) return "stale"
          const currentAttempt = ++initializationAttempt
          const globalState = useGlobalSyncStore.getState()
          const bootstrap = bootstrapDirectory({
            directory,
            store,
            set: (patch) => {
              if (!isCurrent()) return
              store.setState(patch)
              if (patch.session_status) {
                applyGlobalSessionStatusSnapshot(directory, patch.session_status, getDirectoryOwnedSessionIds(directory, store.getState().session))
              }
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            isStale: () => !isCurrent() || currentAttempt !== initializationAttempt,
            global: {
              config: globalState.config,
              projects: globalState.projects,
              path: globalState.path,
            },
            // Each page owns its bounded retry. Replaying the whole list here
            // multiplies attempts and holds a bootstrap slot behind failures.
            loadSessions: async (dir) => {
              if (!isCurrent()) return
              const baselineRevision = store.getState().sessionRevision ?? 0
              // One list covers the directory: v2 has no roots or archived
              // filter, so roots and child sessions (sub-agent delegations)
              // arrive together and are split here. Children must be present
              // for pending forms to scope to them right after a restart.
              const { active } = splitGlobalSessionsByArchived(
                await listGlobalSessionPages(listSessionPage, { directory: dir, pageSize: 500 }),
              )
              const allSessions = active
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const rootSessions = allSessions.filter((s) => !s.parentID)
              if (!isCurrent()) return

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
            },
          })
          context.trackInitialization(bootstrap.environment.then((result) => {
            if (result === "failed") return failBootstrap()
          }))
          const result = await bootstrap.sessions
          if (!isCurrent()) return "stale"
          if (result !== "complete") return result

          // VS Code-only race: the bridge can answer with an empty 200 (instead
          // of a retryable 503) while OpenCode is still warming up, which the
          // page retries inside loadSessions can't catch. Re-run a few times there.
          //
          // On web/desktop this retry is both redundant and harmful: loadSessions
          // already retries transient failures (listGlobalSessionPages throws on
          // 5xx and retries internally), so an empty result here is AUTHORITATIVE —
          // the directory genuinely has no sessions (e.g. a deleted worktree only
          // referenced by archived sessions). Re-running the full bootstrap 6×2s
          // per such directory is the startup log storm.
          if (isVSCodeRuntime() && isCurrent()) {
            const state = store.getState()
            if (state.session.length === 0 && attempt < 5) {
              console.warn(`[bootstrap] sessions empty for ${directory} after attempt ${attempt + 1}; retrying in 2s`)
              await new Promise((r) => setTimeout(r, 2000))
              if (!isCurrent()) return "stale"
              store.setState({ status: "loading" as const })
              return runBootstrap(attempt + 1)
            } else if (state.session.length === 0) {
              console.warn(`[bootstrap] sessions empty for ${directory} after ${attempt + 1} attempts; giving up`)
            }
          }
          return "complete"
        }

        const result = await runBootstrap(0)
        if (result === "failed") await failBootstrap()

        // Selecting a session whose directory this client had not indexed yet
        // routes it through the active directory as a documented guess. This is
        // the moment that guess can be settled: the owning store now holds the
        // session, so the authoritative directory is finally readable. Without
        // this the guess survives, every fetch is addressed to a directory that
        // does not own the session, and the session never renders.
        if (result === "complete") {
          useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()
        }
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
    bootstrapGlobal((patch) => {
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
    const unsubscribeQueueEvents = subscribeMessageQueueSync(runtimeKey)
    const resyncAfterStreamGap = (reason: SessionMaterializationReason) => {
      for (const dir of childStores.children.keys()) triggerDirectoryResync(dir, reason)
    }
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
              const { version } = payload.properties
              if (version) dispatchOpenCodeUpdateAvailable({ version })
            }
            handleEvent(directory, payload, childStores, routingIndex, runtimeKey, false, currentDirectoryRef.current, batch)
          }
        } finally {
          publishDirectoryEventBatch(batch)
        }
      },
      onReconnect: ({ replayReset }) => {
        // Queue recovery is independent of the directory-bootstrap debounce.
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        const isFirstConnect = !pipelineHasConnectedRef.current
        pipelineHasConnectedRef.current = true
        if (!replayReset && isFirstConnect && !pipelineDisconnectedBeforeFirstConnectRef.current) {
          return
        }
        if (!replayReset && isRecentBoot()) {
          return
        }
        resyncAfterStreamGap("stream-reconnect")
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
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        // Transport changes are gap-prone in real networks. Treat them like a
        // reconnect and refresh active session snapshots from HTTP.
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        resyncAfterStreamGap("transport-switch")
      },
    })
    pipelineReconnectRef.current = pipeline.reconnect
    return () => {
      if (pipelineReconnectRef.current === pipeline.reconnect) {
        pipelineReconnectRef.current = null
      }
      pipeline.cleanup()
      unsubscribeQueueEvents()
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
      if (childDiscoveryDirectories.has(directory)) return
      childDiscoveryDirectories.add(directory)
      try {
        // Paginated so directories with > pageSize sessions are fully
        // discovered; a single 200-record page silently truncated the list and
        // left subagent children beyond it undiscovered.
        const { active: allSessions } = splitGlobalSessionsByArchived(
          await listGlobalSessionPages(listSessionPage, { directory, pageSize: 200 }),
        )
        const state = store.getState()
        const globalEntities = useGlobalSessionsStore.getState().entityById
        const newChildSessions = selectNewChildSessions(
          allSessions,
          new Set(state.session.map((s) => s.id)),
          new Set(parentSessionIds),
          (sessionId) => Boolean(globalEntities.get(sessionId)?.time?.archived),
        )
        if (newChildSessions.length === 0) return
        // Collect unique parent IDs for materialization
        const parentIdsForMaterialization = new Set<string>()
        for (const session of newChildSessions) {
          if (session.parentID) parentIdsForMaterialization.add(session.parentID)
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
      } finally {
        childDiscoveryDirectories.delete(directory)
      }
    }

    const pollDirectoryStatuses = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      candidateSessionIds: string[],
    ) => {
      const polling = statusPollingDirectories
      if (polling.has(directory)) return
      polling.add(directory)
      try {
        const before = store.getState()
        const statuses = await runBackgroundNetworkTask(() => resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "monotonic"), "active-session")
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
            statusPollingDirectories.clear()
          }
        })
    }

    const interval = setInterval(tick, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS)
    tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [childStores, props.sdk, triggerDirectoryResync])

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
  useEffect(() => messageLoader.startCacheRetention({
    isCurrent: () => getRuntimeKey() === runtimeKey,
    isViewed: ({ directory, sessionID }) => (
      directory === _activeDirectory && sessionID === _activeSession
    ) || (externallyViewedSessions.get(viewedSessionKey(directory, sessionID)) ?? 0) > Date.now(),
    isActive: ({ directory, sessionID }) => {
      const live = useGlobalSessionStatusStore.getState().statusById.get(sessionID)
      return live?.directory === directory && live.status.type !== "idle"
    },
    releaseDerivedCache: ({ directory, sessionID }) => {
      const store = childStores.getChild(directory)
      if (store) dropCachedSessionMessageRecordsSnapshots(store, [sessionID])
    },
  }), [childStores, messageLoader, runtimeKey])

  useEffect(() => {
    setImperativeSessionMessageLoader(messageLoader)
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
      (directory, sessionID, messageID) => {
        enqueueSessionMaterialization(directory, sessionID, childStores, {
          reason: "settled-running-tool",
          messageID,
        })
      },
    )
    return () => {
      if (getImperativeSessionMessageLoader() === messageLoader) {
        setImperativeSessionMessageLoader(null)
      }
    }
  }, [props.sdk, props.directory, childStores, messageLoader, routingIndex])

  useEffect(() => {
    if (messageLoaderDisposalTimerRef.current) {
      clearTimeout(messageLoaderDisposalTimerRef.current)
      messageLoaderDisposalTimerRef.current = null
    }
    messageLoader.activate()
    return () => {
      // Strict Mode probes effects with setup → cleanup → setup in one task.
      // Deferring destruction lets child effects issue their second setup load
      // before this provider is installed again and cancels the cleanup.
      messageLoaderDisposalTimerRef.current = setTimeout(() => {
        messageLoaderDisposalTimerRef.current = null
        messageLoader.dispose()
        childStores.disposeAll()
      }, 0)
    }
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

  // Directory navigation must not republish stable runtime dependencies.
  return (
    <SyncContext.Provider value={system}>
      <SyncRuntimeContext.Provider value={runtime}>
        {props.children}
      </SyncRuntimeContext.Provider>
    </SyncContext.Provider>
  )
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
  const runtime = useSyncRuntime()
  // With an explicit directory the snapshot is a constant, so a current-
  // directory change does not re-render this consumer.
  const dir = React.useSyncExternalStore(
    runtime.currentDirectory.subscribe,
    () => directory ?? runtime.currentDirectory.get(),
  )
  const store = runtime.childStores.ensureChild(dir, options)

  useEffect(() => {
    runtime.childStores.pin(dir)
    return () => runtime.childStores.unpin(dir)
  }, [dir, runtime.childStores])

  return store
}

export function useSessionMessageLoader(): SessionMessageLoader {
  return useSyncRuntime().messageLoader
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

const EMPTY_PARTS_BY_MESSAGE: Record<string, Part[]> = {}

/**
 * Get parts for several messages at once, keyed by message id. The snapshot
 * keeps its identity until one of the requested part arrays changes, so a
 * streaming turn can overlay every one of its step messages — not only the
 * currently streaming one — without tearing between them when the stream
 * moves to the next message.
 */
export function useSessionPartsForMessages(messageIDs: readonly string[], directory?: string): Record<string, Part[]> {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{ ids: readonly string[]; parts: Record<string, Part[]> } | null>(null)
  const getSnapshot = useCallback(() => {
    if (messageIDs.length === 0) return EMPTY_PARTS_BY_MESSAGE
    const state = store.getState()
    const cached = cacheRef.current
    if (
      cached
      && cached.ids === messageIDs
      && messageIDs.every((id) => (state.part[id] ?? EMPTY_PARTS) === (cached.parts[id] ?? EMPTY_PARTS))
    ) {
      return cached.parts
    }
    const parts: Record<string, Part[]> = {}
    for (const id of messageIDs) parts[id] = state.part[id] ?? EMPTY_PARTS
    cacheRef.current = { ids: messageIDs, parts }
    return parts
  }, [messageIDs, store])
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

/** Whether this directory has received a successful authoritative status snapshot. */
export function useSessionStatusSnapshotReady(directory?: string): boolean {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => store.getState().sessionStatusReady === true, [store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.sessionStatusReady !== previous.sessionStatusReady) notify()
  }), [store])
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

/** Get pending forms for a specific session */
export function useSessionForms(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.form[sessionID] ?? EMPTY_FORM_REQUESTS, [sessionID]),
    directory,
  )
}

/**
 * Total number of pending forms across the given session scopes. Each
 * scope names a directory store plus the session IDs to count inside it, so
 * collapsed subtree rows can roll up pending forms of hidden descendants
 * from their owning directory stores without bootstrapping them.
 *
 * Subscribes through the per-session form sidecar channel, so unrelated
 * streaming or session activity does not re-render rows.
 */
export function useSessionFormCount(scopes: readonly { directory: string; sessionIDs: readonly string[] }[]) {
  // Runtime only: the current directory is not an input here, and reading the
  // directory-bearing context would re-render every sidebar row that counts
  // forms whenever the user switches projects.
  const { childStores } = useSyncRuntime()
  const scopedStores = React.useMemo(() => scopes.map((scope) => ({
    sessionIDs: scope.sessionIDs,
    store: childStores.ensureChild(scope.directory, { bootstrap: false }),
  })), [childStores, scopes])
  React.useEffect(() => {
    for (const scope of scopes) childStores.pin(scope.directory)
    return () => {
      for (const scope of scopes) childStores.unpin(scope.directory)
    }
  }, [childStores, scopes])
  const getSnapshot = React.useCallback(() => {
    let count = 0
    for (const { sessionIDs, store } of scopedStores) {
      const forms = store.getState().form
      for (const sessionID of sessionIDs) count += forms[sessionID]?.length ?? 0
    }
    return count
  }, [scopedStores])
  const subscribe = React.useCallback((notify: () => void) => {
    const unsubscribers = scopedStores.map(({ sessionIDs, store }) => (
      subscribeDirectoryForms(store, sessionIDs, notify)
    ))
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [scopedStores])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const selectPermissionRequestsBySession = (state: State) => state.permission
const selectFormRequestsBySession = (state: State) => state.form

/**
 * Forms for the composer of `sessionID`: the session subtree's own, then the
 * directory's location-scoped ones. A location-scoped form has no session to
 * be viewed from, so every session of its directory offers it; the answer is
 * still sent to that directory's OpenCode instance because the reply
 * resolves its directory from the store that holds the form.
 */
export const collectComposerForms = (
  sessions: Session[],
  formsBySession: Record<string, FormRequest[] | undefined>,
  sessionID: string | null,
  empty: FormRequest[],
): FormRequest[] => {
  const own = collectScopedBlockingRequests(sessions, formsBySession, sessionID, empty)
  const locationScoped = sessionID ? formsBySession[LOCATION_SCOPED_FORM_SESSION_ID] : undefined
  if (!locationScoped || locationScoped.length === 0) return own
  return own === empty ? locationScoped : [...own, ...locationScoped]
}

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
  collect: (
    sessions: Session[],
    requestsBySession: Record<string, T[] | undefined>,
    sessionID: string | null,
    empty: T[],
  ) => T[] = collectScopedBlockingRequests,
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

      const next = collect(state.session, requestsBySession, sessionID, empty)
      const result = areRequestArraysReferentiallyEqual(cache.result, next) ? cache.result : next
      cacheRef.current = {
        sessionID,
        sessions: state.session,
        requestsBySession,
        result,
      }
      return result
    }, [collect, empty, selectRequestsBySession, sessionID]),
    directory,
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingForms(sessionID: string | null, directory?: string): FormRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectFormRequestsBySession, EMPTY_FORM_REQUESTS, collectComposerForms)
}

const sessionsByIdCache = new WeakMap<State["session"], Map<string, Session>>()

const getSessionById = (sessions: State["session"], sessionID?: string | null): Session | undefined => {
  if (!sessionID) return undefined
  let sessionsById = sessionsByIdCache.get(sessions)
  if (!sessionsById) {
    sessionsById = new Map(sessions.map((session) => [session.id, session]))
    sessionsByIdCache.set(sessions, sessionsById)
  }
  return sessionsById.get(sessionID)
}

export function useParentSession(sessionID: string | null, directory?: string): Session | null {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return null
      const current = getSessionById(state.session, sessionID)
      if (!current?.parentID) return null
      return getSessionById(state.session, current.parentID)
        ?? getAllSyncSessions().find((s) => s.id === current.parentID)
        ?? null
    }, [sessionID]),
    directory,
  )
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncRuntime()
  const getSnapshot = useCallback(() => {
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      return sessions ? getSessionById(sessions, sessionID) : undefined
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
  return useSyncRuntime().sdk
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncRuntime().childStores
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

function dropCachedSessionMessageRecordsSnapshots(
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

/**
 * The user's prompts in the visible transcript of a session, oldest first.
 * Session-scoped ArrowUp recall merges this with the persisted input history,
 * so sessions that predate the persisted store still recall their prompts.
 */
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

/**
 * @param enabled Gate for callers that only need a session materialised under
 * a specific condition — a panel resolving pinned message text, say. Loading a
 * whole session is not free, so "something is missing" is not on its own a
 * reason to fetch it.
 */
export function useEnsureSessionMessages(sessionID: string, directory?: string, enabled = true) {
  const syncDirectory = useSyncDirectory()
  const resolvedDirectory = directory ?? syncDirectory
  const store = useDirectoryStore(resolvedDirectory)
  const requestGenerationRef = React.useRef(0)

  React.useEffect(() => {
    if (!sessionID || !enabled) return

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
  }, [enabled, sessionID, store, resolvedDirectory])
}
const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_FORM_REQUESTS: FormRequest[] = []
