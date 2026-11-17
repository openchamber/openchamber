/* oxlint-disable react/only-export-components */
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
  SessionOutcome,
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
  subscribeDirectoryPermissions,
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
import { recordDirectoryRecoveryEvent, selectHeldSessionStatuses } from "./directory-recovery-snapshots"
import { hasPromptInFlight, withPromptsInFlight } from "./prompts-in-flight"
import { applyRecoverableQuestionEvents, deriveRecoveredQuestions, noteDeferredAnswersLoaded, noteQuestionFormSnapshot, useRecoverableQuestionsStore, type RecoveredQuestion } from "./recoverable-questions"
import { adoptSessionMove, setActionRefs } from "./session-actions"
import { subscribeSessionAdmission } from "./session-admission"
import { setSyncRefs, getAllSyncSessions, emitSyncConfigChanged, getDirectoryState } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { stripSessionDiffSnapshots } from "./sanitize"
import { upsertSessionRecord } from "./session-records"
import {
  applySessionEventToGlobalSessions,
  applySessionEventsToGlobalSessions,
} from "./session-event-router"
import { shouldConsumeBulkArchiveEcho } from "./bulk-archive-echo"
import { applyForkedSession, noteForkedSessionPatched } from "./forked-session"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { useUIStore } from "@/stores/useUIStore"
import { useBtwStore } from "@/stores/useBtwStore"
import { selectNewChildSessions } from "./child-session-discovery"
import { syncDebug } from "./debug"
import { normalizePath } from "@/lib/pathNormalization"
import { Binary } from "./binary"
import { getReconnectCandidateSessionIds, mergeBootstrapSessions } from "./reconnect-recovery"
import { messagesBefore } from "./message-ordering"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { policySnapshotFromWire } from "@/stores/utils/permissionAutoAccept"
import { selectSafetyNetAvailable, useRoutingStore } from "@/stores/useRoutingStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { isAutoReviewAvailable, useAutoReviewStore } from "@/stores/useAutoReviewStore"
import { subscribeMessageQueueSync } from "./message-queue-sync"
import { subscribeAutoReviewSync } from "./auto-review-sync"
import { subscribePrWatchSync } from "./pr-watch-sync"
import { subscribeExtensionWaitsSync } from "./extension-waits-sync"
import { subscribeLaterPagesSync } from "./later-pages-sync"
import { subscribeSessionWarmingSync } from "./session-warming-sync"
import { subscribeSessionTodosSync } from "./session-todos-sync"
import { subscribeSessionFoldersSync } from "./session-folders-sync"
import { subscribeSessionDraftsSync } from "./session-drafts-sync"
import { subscribePermissionPolicySync, subscribeSpacePermissionModes } from "./permission-mode-sync"
import { subscribeControlStreamSync } from "./control-stream-sync"
import type { ControlStreamSyncEvent } from "@/lib/openchamberEvents"
import { spaceFoldersOfProject, subscribeSpaceCatalogs } from "./space-catalog-sync"
import { subscribeSpaceSessionProject } from "./space-session-project"
import {
  processVSCodePermissionAutoAccept,
  processVSCodeReconciledPermissionAutoAccept,
} from "./vscode-permission-auto-accept"
import { markConfigCatalogStale, useConfigStore } from "@/stores/useConfigStore"
import { refreshStoresForCatalogKinds } from "@/stores/catalogRefresh"
import { useMcpStore } from "@/stores/useMcpStore"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSpaceDirectory, spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { isDirectoryOfKnownSpace, isSpaceDirectoryStopped, isSpaceStopped, knownSpaceIds, refreshSpacesJourney, spaceIdsGone, spacesRuntimeGeneration, useSpacesStore } from "@/lib/spaces/spaces-store"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { toast } from "@/components/ui"
import { appendErrorNotification, markSessionViewed } from "./notification-store"
import { isSessionUnread } from "./session-unread"
import { recordSessionError, responseBodyOf, summarizeOpenCodeError } from "./session-error-log"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  buildActiveListReconcileEvents,
  getDirectoryOwnedSessionIds,
  setSessionParentResolver,
  useGlobalSessionStatusStore,
  watchGlobalSessionStatusWrites,
} from "./global-session-status"
import { applyGlobalBlockingRequestEvents, applyWaitingPageEvent, settledPageKeys, useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { requestHostTurnStarts } from "./host-session-status-seed"
import { setHostTurnStartRequester } from "./session-activity-timing"
import { applyBackgroundShellEvents, directoriesWithRunningShells, refreshBackgroundShells } from "./background-shells"
import { applyBackgroundImageEvents, refreshBackgroundImages } from "./background-images"
import { applySessionLiveWorkEvents } from "./session-live-work"
import { applyReplyCommandEvents } from "./reply-commands"
import {
  CHAT_LOCATION_RELEASE_DELAY_MS,
  PROJECT_LOCATION_RELEASE_DELAY_MS,
  WORKTREE_LOCATION_RELEASE_DELAY_MS,
  createRealLocationRelease,
  directoryUse,
  isWorktreeDirectory,
  type LocationRelease,
} from "./location-release"
import { applySessionAssistEvent, subscribeSessionAssistSettled } from "./pending-session-assists"
import { useWorkflowRunsStore } from "@/lib/workflows/store"
import { setWorkflowRunningSessions } from "./workflow-activity"
import { isChatDirectoryPath } from "@/lib/chatDirectories"
import type { State } from "./types"
import {
  getSessionMaterializationRequestKey,
  getSessionMaterializationStatus,
  getStaleRunningToolMessageID,
  isSessionMaterializationStillNeeded,
  type SessionMaterializationRequest,
} from "./materialization"
import { openSessionFromToast } from "./session-navigation"
import { revealRequest, revealWaitingPage } from "./request-reveal"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isFilesystemError } from "@/lib/api/files-errors"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import { sessionEvents } from "@/lib/sessionEvents"
import { fileTreeChanges } from "@/lib/fileTreeChanges"
import { notifyWatchedFileChanged, renewWatchedFiles } from "@/lib/watchedFiles"
import { listGlobalSessionPages, splitGlobalSessionsByArchived, type GlobalSessionRecord, type SessionPageLister } from "@/stores/globalSessions"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests, computeSubtreeIds } from "./scoped-blocking-requests"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type TranscriptPrompt, type UserMessageHistorySnapshot } from "./user-message-history"
import {
  EMPTY_SESSION_MESSAGE_LOAD_STATE,
  SessionMessageLoader,
  getImperativeSessionMessageLoader,
  setImperativeSessionMessageLoader,
  type SessionMessageLoadState,
  type SessionMessageTarget,
} from "./session-message-loader"
import { openCodeStartupSignal } from "./opencode-startup-gate"
import { claimFirstServerConnect, notifyFirstServerConnect } from "./first-server-connect"
import { notifyStreamGap } from "./stream-gap"

useWorkflowRunsStore.subscribe((state) => {
  setWorkflowRunningSessions(Object.entries(state.bySession).flatMap(([sessionId, entry]) => (
    entry.runs.some((run) => run.state === "running") ? [sessionId] : []
  )))
})

useGlobalBlockingRequestsStore.subscribe((state, previous) => {
  if (state.bySession === previous.bySession) return
  const settled = settledPageKeys(previous.bySession, state.bySession)
  if (settled.length === 0) return
  const shown = new Set(toast.getToasts().map((entry) => entry.id))
  for (const key of settled) {
    if (shown.has(`page-${key}`)) toast.dismiss(`page-${key}`)
  }
})


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

setSessionParentResolver((sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId)?.parentID)

setHostTurnStartRequester(requestHostTurnStarts)

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
    sourceRevisionRef.current += 1
    return subscribe ? subscribe(childStores, invalidate) : childStores.subscribeAll(invalidate)
  }, [childStores, subscribe])

  return React.useSyncExternalStore(
    subscribeToSource,
    getSnapshot,
    getSnapshot,
  )
}


type SessionMove = { sessionID: string; from: string; to: string }

type DirectoryEventBatch = {
  states: Map<StoreApi<DirectoryStore>, DirectoryStore>
  clonedFields: Map<StoreApi<DirectoryStore>, Set<keyof State>>
  changedStores: Set<StoreApi<DirectoryStore>>
  globalSessionEvents: SyncEvent[]
  globalStatusEventsByDirectory: Map<string, SyncEvent[]>
  sessionMoves: SessionMove[]
}

const createDirectoryEventBatch = (): DirectoryEventBatch => ({
  states: new Map(),
  clonedFields: new Map(),
  changedStores: new Set(),
  globalSessionEvents: [],
  globalStatusEventsByDirectory: new Map(),
  sessionMoves: [],
})

const getDirectoryEventState = (
  store: StoreApi<DirectoryStore>,
  batch?: DirectoryEventBatch,
): DirectoryStore => batch?.states.get(store) ?? store.getState()

const publishDirectoryEventBatch = (batch: DirectoryEventBatch): void => {
  applySessionEventsToGlobalSessions(batch.globalSessionEvents)
  for (const [directory, events] of batch.globalStatusEventsByDirectory) {
    applyBackgroundShellEvents(directory, events)
    applyBackgroundImageEvents(directory, events)
    applySessionLiveWorkEvents(events)
    applyReplyCommandEvents(events)
    applyGlobalSessionStatusEvents(directory, events)
    applyGlobalBlockingRequestEvents(directory, events)
    applyRecoverableQuestionEvents(directory, events)
  }
  for (const store of batch.changedStores) {
    const state = batch.states.get(store)
    if (!state) continue
    countSyncPerformance("directoryStorePublications")
    store.setState(state)
  }
  for (const move of batch.sessionMoves) adoptSessionMove(move.sessionID, move.from, move.to)
}

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

const subscribeLiveSessionLists = (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
  (state: State) => state.session,
  notify,
)

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      return aggregateLiveSessions(states)
    }, []),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

const EMPTY_LIVE_SESSIONS: Session[] = []

export function useLiveSessionsExcluding(excludedIds: ReadonlySet<string>): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      const sessions = aggregateLiveSessions(states).filter((session) => !excludedIds.has(session.id))
      return sessions.length === 0 ? EMPTY_LIVE_SESSIONS : sessions
    }, [excludedIds]),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

let bootingRoot = false
let bootedAt = 0
let globalBootstrapGeneration = 0
const BOOT_DEBOUNCE_MS = 1500
const RECONNECT_MESSAGE_LIMIT = 30
const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30
const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS = 30_000
const ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS = 60_000
const ACTIVE_SESSION_STALE_EVENT_MS = 20_000
const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000
const CHILD_SESSION_DISCOVERY_RETRY_MS = 15_000
const CHILD_SESSION_DISCOVERY_WAIT_MS = 30_000
const WATCHDOG_READ_MAX_BACKOFF_MS = 60_000

type DirectoryReadBackoff = Map<string, { delay: number; retryAt: number }>

function recordWatchdogReadFailure(backoff: DirectoryReadBackoff, directory: string, interval: number): void {
  const delay = Math.min((backoff.get(directory)?.delay ?? interval) * 2, WATCHDOG_READ_MAX_BACKOFF_MS)
  backoff.set(directory, { delay, retryAt: Date.now() + delay })
}


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


type PendingSessionMaterialization = {
  runtimeKey: string
  sessionID: string
  directory: string
  enqueuedAt: number
  request: SessionMaterializationRequest
}

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000
const pendingSessionMaterializations = new Map<string, PendingSessionMaterialization>()

const statusPollingDirectories = new Set<string>()

const childDiscoveryDirectories = new Set<string>()

const pendingMessageCompletionPolls = new Map<string, ReturnType<typeof setTimeout>>()

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
      const movedTo = directorySessionMovedTo(store.getState(), directory, sessionID)
      if (movedTo) {
        if (childStores.getChild(movedTo)) enqueueSessionMaterialization(movedTo, sessionID, childStores, request)
        return
      }
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
    markRecordedInterruptedTurn(store, sessionID)
  }
}

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

const FORM_TOAST_DESCRIPTION = "Agent is waiting for your input"

const openRequestFromToast = (sessionID: string, directory: string, requestID: string) => {
  openSessionFromToast(sessionID, directory)
  revealRequest(requestID)
}

const formToastAction = (sessionID: string, directory: string, formID: string) => (
  sessionID === LOCATION_SCOPED_FORM_SESSION_ID
    ? undefined
    : { label: "Open session", onClick: () => openRequestFromToast(sessionID, directory, formID) }
)

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const notificationToastId = (kind?: string, title?: string, body?: string, tag?: string): string | undefined => {
  if (tag) return tag
  const fallback = [kind, title, body].filter(Boolean).join("|")
  return fallback || undefined
}

const showPluginNotificationToast = (kind?: string, title?: string, body?: string, tag?: string): void => {
  if (kind !== "plugin" || !title) return
  toast.info(title, {
    id: notificationToastId(kind, title, body, tag),
    description: body,
  })
}

const isUiFocused = (): boolean => (
  typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
)

const isUiAway = (): boolean => "document" in globalThis && !isUiFocused()

const handleUiNotificationEvent = (notification: OpenchamberNotification, fallbackDirectory: string): void => {
  const kind = trimmedOrUndefined(notification.kind)
  const sessionId = trimmedOrUndefined(notification.sessionId)
  const directory = trimmedOrUndefined(notification.directory)
    ?? (fallbackDirectory !== "global" ? fallbackDirectory : "")
  const title = trimmedOrUndefined(notification.title)
  const body = trimmedOrUndefined(notification.body)
  const tag = trimmedOrUndefined(notification.tag)

  if (kind === "share-answer" && notification.toastOnly === true) return

  if (kind === "opencode-restart-interrupted" || kind === "opencode-restart-resuming") {
    const dictionary = useI18nStore.getState().dictionary
    const title = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.title")
    const options = {
      id: "opencode-restart-interrupted",
      description: formatMessage(dictionary, kind === "opencode-restart-resuming"
        ? "chat.toast.opencodeRestartInterrupted.autoResumeDescription"
        : "chat.toast.opencodeRestartInterrupted.description"),
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
  } else if (notification.showWhenFocused === true && isUiFocused()) {
    showPluginNotificationToast(kind, title, body, tag)
  }

  if (
    (notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true)
    && getRuntimeKey() === "local"
  ) return

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) return

  void notifications.notifyAgentCompletion({
    title,
    body,
    tag,
    kind,
    sessionId,
    directory: directory || undefined,
    runtimeKey: getRuntimeKey(),
    requireHidden: notification.kind === "plugin" ? true : notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })
}

export function setActiveSession(directory: string, sessionId: string) {
  ensureViewedSessionWatcher()
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
  ensureViewedSessionWatcher()
}

function isDirectoryExternallyViewed(directory: string): boolean {
  pruneExternallyViewedSessions()
  const prefix = `${directory}\n`
  for (const key of externallyViewedSessions.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) {
    return Boolean(_activeDirectory && _activeSession && directory === _activeDirectory && isSurfaceAttended())
  }
  if (
    _activeDirectory && _activeSession
    && directory === _activeDirectory && sessionId === _activeSession
    && isSurfaceAttended()
  ) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(directory, sessionId))
}

let viewedSessionWatcherInstalled = false
function ensureViewedSessionWatcher() {
  if (viewedSessionWatcherInstalled) return
  viewedSessionWatcherInstalled = true
  useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.entityById === previous.entityById) return
    const seeIfViewed = (directory: string, sessionId: string): void => {
      const session = state.entityById.get(sessionId)
      if (!session || session === previous.entityById.get(sessionId) || !isSessionUnread(session)) return
      if (isViewedInCurrentSession(directory, sessionId)) markSessionViewed(sessionId)
    }
    if (_activeDirectory && _activeSession) seeIfViewed(_activeDirectory, _activeSession)
    for (const key of externallyViewedSessions.keys()) {
      const separator = key.indexOf("\n")
      seeIfViewed(key.slice(0, separator), key.slice(separator + 1))
    }
  })
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

function getLiveSessionCandidateIds(state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state)
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

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
    let nextInvalidated: Record<string, true> | undefined
    const draft = () => (next ??= { ...current })

    for (const sessionId of candidateSessionIds) {
      const incoming = toSessionStatus(snapshot[sessionId])
      if (mode === "authoritative" && state.sessionStatusInvalidated?.[sessionId]) {
        nextInvalidated ??= { ...state.sessionStatusInvalidated }
        delete nextInvalidated[sessionId]
        changed = true
      }

      if (incoming && incoming.type !== "idle") {
        const held = current[sessionId]
        if (incoming.type === "busy" && held?.type === "retry" && (held.next === undefined || held.next > Date.now())) continue
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        continue
      }

      if (mode === "monotonic" || hasPromptInFlight(sessionId)) continue

      const existing = current[sessionId]
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    if (!next && !nextInvalidated) return state
    const patch: Partial<DirectoryStore> = {}
    if (next) patch.session_status = next
    if (nextInvalidated) patch.sessionStatusInvalidated = nextInvalidated
    return patch
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
  const invalidatedAtStart = store.getState().sessionStatusInvalidated
  const nextStatuses = await opencodeClient.getActiveSessionStatuses(directory)
  if (nextStatuses === null || isStale?.()) return null
  const currentInvalidated = store.getState().sessionStatusInvalidated
  const eligibleIds = candidateSessionIds.filter((id) => (
    !currentInvalidated?.[id] || currentInvalidated === invalidatedAtStart
  ))
  applySessionStatusSnapshot(store, nextStatuses, eligibleIds, mode)
  if (mode === "authoritative") {
    store.setState({ sessionStatusReady: true })
    const state = store.getState()
    applyGlobalSessionStatusSnapshot(
      directory,
      withPromptsInFlight(selectHeldSessionStatuses(nextStatuses, state.session), state.session_status),
      getDirectoryOwnedSessionIds(directory, state.session),
    )
  }
  return nextStatuses
}

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

export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  if (hasPromptInFlight(sessionId)) return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}

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
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

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

const isBlockingRequestEvent = (payload: SyncEvent): boolean => (
  payload.type === "permission.asked"
  || payload.type === "permission.replied"
  || payload.type === "form.created"
  || payload.type === "form.settled"
)

const directorySessionMovedTo = (state: State, directory: string, sessionID: string): string | null => {
  if (state.sessionDeletedRevision?.[sessionID] === undefined) return null
  if (state.session.some((session) => session.id === sessionID)) return null
  const ownDirectory = resolveCachedSessionDirectory(sessionID)
  if (ownDirectory === null) return null
  return normalizeEventDirectory(ownDirectory) === normalizeEventDirectory(directory) ? null : ownDirectory
}

const resolveDirectoryFromRoutingIndex = (
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

export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean },
) {
  const isCurrentRuntime = captureRuntimeInstance()
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return true
  const candidates = Array.from(candidateIds)
  let succeeded = true

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.form[sessionId])]),
    )
    const pendingForms = await opencodeClient.listPendingForms({ directories: [directory] })
    if (!isCurrentRuntime()) return false
    noteQuestionFormSnapshot(directory, pendingForms)
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
          action: formToastAction(sessionId, directory, form.id),
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
    succeeded = false
  }

  if (options?.includePermissions === false) return succeeded

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    if (!isCurrentRuntime()) return false
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
          openSession: openRequestFromToast,
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
    succeeded = false
  }
  return succeeded
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
  if (candidateSessionIds.length === 0) return true

  const statuses = await resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "authoritative", isStale)
  let succeeded = statuses !== null
  if (isStale()) return

  if (reason !== "stream-replayed") await Promise.all(candidateSessionIds.map(async (sessionId) => {
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const loader = getImperativeSessionMessageLoader()
    const [session] = await Promise.all([
      retry(() => opencodeClient.getSession(sessionId, directory)).catch(() => null),
      loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT) ?? Promise.resolve(),
    ])
    if (isStale()) return
    if (!session || loader?.getSnapshot({ directory, sessionID: sessionId }).status === "error") succeeded = false
    markRecordedInterruptedTurn(store, sessionId)
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
  const blockingRequestsSucceeded = await resyncBlockingRequestsForDirectory(directory, store, candidateSessionIds)

  if (isStale()) return
  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
  return succeeded && blockingRequestsSucceeded
}

export async function reconcileActivityAfterGap(childStores: ChildStoreManager): Promise<void> {
  const runtime = { key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() }
  const writes = watchGlobalSessionStatusWrites()
  try {
    const active = await opencodeClient.getActiveSessionStatuses()
    if (!active || !isCatalogRuntimeCurrent(runtime)) return
    const activeSessionIds = new Set(Object.keys(active))
    const events = buildActiveListReconcileEvents(activeSessionIds, {
      skip: (sessionId) => writes.touched.has(sessionId) || hasPromptInFlight(sessionId),
      covers: (directory) => !isSpaceDirectory(directory),
      resolveDirectory: (sessionId) => {
        const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
        return session ? resolveGlobalSessionDirectory(session) : null
      },
    })
    for (const [directory, payloads] of events) applyGlobalSessionStatusEvents(directory, payloads)
    childStores.refreshStaleDirectoriesWithActiveSessions(activeSessionIds)
  } finally {
    writes.stop()
  }
}

type CatalogRuntime = { key: string; sdk: ReturnType<typeof opencodeClient.getSdkClient> }

const isCatalogRuntimeCurrent = (runtime: CatalogRuntime): boolean =>
  runtime.key === getRuntimeKey() && runtime.sdk === opencodeClient.getSdkClient()

async function reloadCatalog(
  kind: CatalogKind,
  childStores: ChildStoreManager,
  eventDirectories: readonly string[],
  runtime: CatalogRuntime,
): Promise<void> {
  if (!isCatalogRuntimeCurrent(runtime)) return
  if (kind === "config") opencodeClient.clearConfigCache()

  if (kind === "project") {
    const projects = await opencodeClient.listProjects().catch(() => null)
    if (isCatalogRuntimeCurrent(runtime) && projects) {
      useGlobalSyncStore.getState().actions.set({ projects })
    }
    return
  }
  if (kind !== "config") return

  await Promise.all(eventDirectories.map(async (directory) => {
    const store = childStores.getChild(directory)
    if (!store) return
    if (!isCatalogRuntimeCurrent(runtime)) return
    try {
      const config = await opencodeClient.getConfig(directory)
      if (!isCatalogRuntimeCurrent(runtime)) return
      store.setState({ config })
      emitSyncConfigChanged(directory, config)
    } catch {
      // Best-effort: the next catalog event or bootstrap re-reads it.
    }
  }))
}

const CATALOG_RELOAD_DEBOUNCE_MS = 250
const pendingCatalogReloads = new Map<CatalogKind, Set<string>>()
const pendingCatalogCurrentKinds = new Set<CatalogKind>()
let pendingCatalogRuntime: CatalogRuntime | null = null
let catalogReloadTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCatalogReload(
  kind: CatalogKind,
  childStores: ChildStoreManager,
  directory: string | null,
): void {
  const runtime = { key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() }
  markConfigCatalogStale(kind, directory)
  if (directory) for (const spaceFolder of spaceFoldersOfProject(directory)) markConfigCatalogStale(kind, spaceFolder)
  if (pendingCatalogRuntime && !isCatalogRuntimeCurrent(pendingCatalogRuntime)) {
    pendingCatalogReloads.clear()
    pendingCatalogCurrentKinds.clear()
  }
  pendingCatalogRuntime = runtime
  const directories = pendingCatalogReloads.get(kind) ?? new Set<string>()
  if (directory) directories.add(directory)
  else pendingCatalogCurrentKinds.add(kind)
  pendingCatalogReloads.set(kind, directories)
  if (catalogReloadTimer) clearTimeout(catalogReloadTimer)
  catalogReloadTimer = setTimeout(() => {
    catalogReloadTimer = null
    const scheduledRuntime = pendingCatalogRuntime
    pendingCatalogRuntime = null
    const reloads = [...pendingCatalogReloads.entries()]
    const currentKinds = new Set(pendingCatalogCurrentKinds)
    pendingCatalogReloads.clear()
    pendingCatalogCurrentKinds.clear()
    if (!scheduledRuntime || !isCatalogRuntimeCurrent(scheduledRuntime)) return
    const currentDirectory = opencodeClient.getDirectory()
    for (const [pendingKind, pendingDirectories] of reloads) {
      if (currentKinds.has(pendingKind) && currentDirectory) pendingDirectories.add(currentDirectory)
      void reloadCatalog(pendingKind, childStores, [...pendingDirectories], scheduledRuntime)
    }
    void refreshStoresForCatalogKinds(new Map([...reloads].map(([kind, directories]) => [kind, [...directories]])))
  }, CATALOG_RELOAD_DEBOUNCE_MS)
}

const MCP_STATUS_REFRESH_DEBOUNCE_MS = 250
const mcpStatusRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleMcpStatusRefresh(directory: string): void {
  if (dormantLocations.has(directory)) return
  const pending = mcpStatusRefreshTimers.get(directory)
  if (pending) clearTimeout(pending)
  mcpStatusRefreshTimers.set(directory, setTimeout(() => {
    mcpStatusRefreshTimers.delete(directory)
    void useMcpStore.getState().refreshIfHeld(directory)
  }, MCP_STATUS_REFRESH_DEBOUNCE_MS))
}

function cancelMcpStatusRefresh(directory: string): void {
  const pending = mcpStatusRefreshTimers.get(directory)
  if (pending) clearTimeout(pending)
  mcpStatusRefreshTimers.delete(directory)
}

function forgetMcpStatus(directory: string): void {
  cancelMcpStatusRefresh(directory)
  useMcpStore.getState().forgetDirectory(directory)
}

const dormantLocations = new Set<string>()

export function wakeDormantLocations(childStores: ChildStoreManager, currentDirectory: string | null | undefined): void {
  for (const directory of dormantLocations) {
    if (directory !== currentDirectory) {
      forgetMcpStatus(directory)
      continue
    }
    if (childStores.getChild(directory)) {
      childStores.requestBootstrap({ directory, priority: "selected", reason: "location-shutdown", force: true })
    }
    void useMcpStore.getState().refreshIfHeld(directory)
  }
  dormantLocations.clear()
}

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
    openSession: openRequestFromToast,
  })
}

const isAnsweredWithoutUser = (sessionID: string): boolean => {
  const mode = usePermissionStore.getState().getSessionMode(sessionID)
  return mode === "auto" || (mode === "safety" && selectSafetyNetAvailable(useRoutingStore.getState()))
}

const MAX_EARLY_LEFT_FOR_USER = 100
const permissionsAwaitingAutoAnswer = new Map<string, () => void>()
const leftForUserBeforeAsked = new Set<string>()
const autoAnswerKey = (sessionID: string, permissionID: string) => `${sessionID}\n${permissionID}`

const isHeldUntilAutoAnswered = (permission: PermissionRequest): boolean =>
  !leftForUserBeforeAsked.has(autoAnswerKey(permission.sessionID, permission.id)) && !isVSCodeRuntime() && isAnsweredWithoutUser(permission.sessionID)

const holdBackUntilAutoAnswered = (permission: PermissionRequest, replayAsAsk: () => void): boolean => {
  const key = autoAnswerKey(permission.sessionID, permission.id)
  if (leftForUserBeforeAsked.delete(key)) return false
  if (!isHeldUntilAutoAnswered(permission)) return false
  permissionsAwaitingAutoAnswer.set(key, replayAsAsk)
  return true
}

const showPermissionLeftForUser = (
  { permissionId, sessionId, directory, spaceId }: Extract<SyncEvent, { type: "openchamber.permission-left-for-user" }>["properties"],
): void => {
  if (spaceId && spaceIdOfDirectory(useSessionUIStore.getState().getDirectoryForSession(sessionId)) !== spaceId) return
  const key = autoAnswerKey(sessionId, permissionId)
  const replayAsAsk = permissionsAwaitingAutoAnswer.get(key)
  if (replayAsAsk) {
    permissionsAwaitingAutoAnswer.delete(key)
    replayAsAsk()
    return
  }
  if (directory && getDirectoryState(directory)?.permission[sessionId]?.some((entry) => entry.id === permissionId)) return
  leftForUserBeforeAsked.add(key)
  const oldest = leftForUserBeforeAsked.values().next()
  if (leftForUserBeforeAsked.size > MAX_EARLY_LEFT_FOR_USER && !oldest.done) leftForUserBeforeAsked.delete(oldest.value)
}

const permissionReplayAsAsk = (
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  streamingDirectory: string | undefined,
) => () => {
  if (expectedRuntimeKey !== getRuntimeKey()) return
  handleEvent(rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, true, streamingDirectory, undefined, false)
}

const forgetAutoAnswerWait = (sessionID: string, permissionID: string): void => {
  permissionsAwaitingAutoAnswer.delete(autoAnswerKey(sessionID, permissionID))
  leftForUserBeforeAsked.delete(autoAnswerKey(sessionID, permissionID))
}

const notifyFormCreated = (form: FormRequest, directory: string): void => {
  const sessionID = form.sessionID
  const toastKey = getFormToastKey(sessionID, form.id)
  if (isViewedInCurrentSession(directory, sessionID) || !toastKey || pendingFormToastIds.has(toastKey)) return
  pendingFormToastIds.add(toastKey)
  toast.info(form.title, {
    id: `form-${toastKey}`,
    description: FORM_TOAST_DESCRIPTION,
    action: formToastAction(sessionID, directory, form.id),
  })
}

const notifyWaitingPage = (event: Extract<SyncEvent, { type: "openchamber.page-waiting" }>): void => {
  const { sessionID, page } = event.properties
  const directory = event.properties.directory ?? resolveCachedSessionDirectory(sessionID)
  if (!directory || isViewedInCurrentSession(directory, sessionID)) return
  toast.info(page.title, {
    id: `page-${sessionID}:${page.id}`,
    description: FORM_TOAST_DESCRIPTION,
    action: {
      label: "Open session",
      onClick: () => {
        revealWaitingPage(sessionID)
        openSessionFromToast(sessionID, directory)
      },
    },
  })
}

const notifyBlockingRequestWithoutStore = (payload: SyncEvent, directory: string, replayAsAsk: (() => void) | null): void => {
  if (isVSCodeRuntime()) return
  if (payload.type === "permission.asked") {
    const permission = payload.properties
    if (replayAsAsk && holdBackUntilAutoAnswered(permission, replayAsAsk)) return
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
  const responseBody = payload.type === "session.error" ? responseBodyOf(payload.properties.error) : null
  if (errorSummary) {
    recordSessionError({ sessionId: sessionID, directory, ...errorSummary })
  }
  if (!errorSummary || isSubtaskSession(sessionID, directory, childStores, batch)) return
  appendErrorNotification({
    directory,
    session: sessionID,
    time: Date.now(),
    error: { ...errorSummary, responseBody },
  })
}

type ControlStreamOnlyEvent = Exclude<ControlStreamSyncEvent, { type: "session.patched" }>

const isControlStreamOnlyEvent = (payload: SyncEvent): payload is ControlStreamOnlyEvent => (
  payload.type === "openchamber.page-waiting"
  || payload.type === "openchamber.page-settled"
  || payload.type === "openchamber.session-assist"
  || payload.type === "openchamber.workflow-run"
  || payload.type === "openchamber.workflow-run-removed"
)

const applyControlStreamOnlyEvent = (payload: ControlStreamOnlyEvent): void => {
  switch (payload.type) {
    case "openchamber.page-waiting":
    case "openchamber.page-settled":
      applyWaitingPageEvent(payload, resolveCachedSessionDirectory)
      if (payload.type === "openchamber.page-waiting") notifyWaitingPage(payload)
      return
    case "openchamber.session-assist":
      applySessionAssistEvent(payload.properties, resolveCachedSessionDirectory)
      return
    case "openchamber.workflow-run":
      useWorkflowRunsStore.getState().apply(payload.properties.run)
      return
    case "openchamber.workflow-run-removed":
      useWorkflowRunsStore.getState().remove(payload.properties.parentSessionId, payload.properties.runId)
      return
  }
}

export function handleEvent(
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  autoAnswerDeclined = false,
  streamingDirectory?: string,
  batch?: DirectoryEventBatch,
  globalEffectsAlreadyApplied = false,
) {
  if (payload.type === "openchamber.notification") {
    handleUiNotificationEvent(payload.properties, normalizeEventDirectory(rawDirectory))
    return
  }

  if (payload.type === "openchamber.permission-left-for-user") {
    showPermissionLeftForUser(payload.properties)
    return
  }

  if (isControlStreamOnlyEvent(payload)) return

  if (payload.type === "filesystem.changed") {
    if (expectedRuntimeKey !== getRuntimeKey()) return
    notifyWatchedFileChanged(payload.properties.file)
    return
  }

  if (payload.type === "openchamber.permission-auto-accept") {
    usePermissionStore.getState().applySnapshot(policySnapshotFromWire(payload.properties), expectedRuntimeKey, payload.properties.spaceId ?? "")
    return
  }

  if (shouldConsumeBulkArchiveEcho(payload, expectedRuntimeKey)) return

  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores, batch)

  if (payload.type === "location.shutdown") {
    if (!directory || directory === "global" || expectedRuntimeKey !== getRuntimeKey()) return
    if (directory !== opencodeClient.getDirectory()) {
      forgetMcpStatus(directory)
      return
    }
    if (isUiAway()) {
      dormantLocations.add(directory)
      cancelMcpStatusRefresh(directory)
      return
    }
    dormantLocations.delete(directory)
    if (childStores.getChild(directory)) {
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

  const globalMoveSource = payload.type === "session.patched" && payload.properties.patch.directory !== undefined
    && expectedRuntimeKey === getRuntimeKey()
    ? resolveCachedSessionDirectory(payload.properties.sessionID)
    : null

  if (!globalEffectsAlreadyApplied) {
    const heldForAutoAnswer = payload.type === "permission.asked"
      && !autoAnswerDeclined
      && isHeldUntilAutoAnswered(payload.properties)
    if (batch) {
      batch.globalSessionEvents.push(payload)
      if (!heldForAutoAnswer) {
        const statusEvents = batch.globalStatusEventsByDirectory.get(directory)
        if (statusEvents) statusEvents.push(payload)
        else batch.globalStatusEventsByDirectory.set(directory, [payload])
      }
    } else {
      applySessionEventToGlobalSessions(payload)
      applyBackgroundShellEvents(directory, [payload])
      applyBackgroundImageEvents(directory, [payload])
      applySessionLiveWorkEvents([payload])
      applyReplyCommandEvents([payload])
      applyGlobalSessionStatusEvent(directory, payload)
      if (!heldForAutoAnswer) applyGlobalBlockingRequestEvents(directory, [payload])
      applyRecoverableQuestionEvents(directory, [payload])
    }
  }

  if ((payload.type === "session.idle" || payload.type === "session.error") && directory && directory !== "global") {
    recordTurnOutcomeNotification(payload, directory, childStores, batch)
  }

  if (directory === "global" || !directory) {
    const recent = isRecentBoot()
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "catalog") {
      scheduleCatalogReload(result.kind, childStores, null)
    }
    if (payload.type === "server.connected") {
      void runBackgroundNetworkTask(() => refreshBackgroundImages(() => opencodeClient.listRunningImageJobs()))
        .catch(() => undefined)
      if (expectedRuntimeKey === getRuntimeKey() && claimFirstServerConnect(childStores, expectedRuntimeKey)) {
        childStores.retryFailedBootstraps()
        notifyFirstServerConnect(expectedRuntimeKey)
      }
      if (!recent) {
        getImperativeSessionMessageLoader()?.markHistoryStale()
        const refreshing = childStores.refreshAfterStreamRestart(opencodeClient.getDirectory())
        for (const dir of directoriesWithRunningShells()) {
          if (refreshing.has(normalizePath(dir) ?? dir)) continue
          void runBackgroundNetworkTask(() => refreshBackgroundShells(dir, (target) => opencodeClient.listRunningShells(target)))
            .catch(() => undefined)
        }
        void reconcileActivityAfterGap(childStores)
      }
    }
    return
  }

  let store = childStores.getChild(directory)
  let resolvedDirectory = directory

  if (!store) {
    const sessionID = syncEventSessionID(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (payload.type === "permission.replied" && payload.properties.requestID) {
    forgetAutoAnswerWait(payload.properties.sessionID, payload.properties.requestID)
  }

  if (!store) {
    if (payload.type === "session.revert.committed") {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID: payload.properties.sessionID })
    }
    const replayAsAsk = payload.type === "permission.asked" && !autoAnswerDeclined
      ? permissionReplayAsAsk(rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, streamingDirectory)
      : null
    notifyBlockingRequestWithoutStore(payload, directory, replayAsAsk)
    if (payload.type === "mcp.status.changed") scheduleMcpStatusRefresh(directory)
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "catalog") {
      scheduleCatalogReload(result.kind, childStores, directory)
    }
    deliverSessionMove(globalSessionMove(payload, globalMoveSource), batch)
    return
  }

  childStores.mark(resolvedDirectory)

  if (payload.type === "permission.asked") {
    const permission: PermissionRequest = payload.properties
    if (isVSCodeRuntime() && !autoAnswerDeclined) {
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
    if (!autoAnswerDeclined && holdBackUntilAutoAnswered(
      permission,
      permissionReplayAsAsk(rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, streamingDirectory),
    )) {
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      return
    }

    notifyPermissionAsked(permission, resolvedDirectory)
  }

  if (payload.type === "permission.replied") {
    const { sessionID, requestID } = payload.properties
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

  const current = getDirectoryEventState(store, batch)
  const toolPartRef = payload.type === "message.part.updated"
    ? { messageID: payload.properties.part.messageID, partID: payload.properties.part.id }
    : payload.type === "message.tool.transition"
      ? { messageID: payload.properties.messageID, partID: payload.properties.partID }
      : undefined
  const previousPart = toolPartRef
    ? current.part[toolPartRef.messageID]?.find((part) => part.id === toolPartRef.partID)
    : undefined
  const directoryBeforePatch = payload.type === "session.patched" && payload.properties.patch.directory !== undefined
    ? current.session.find((session) => session.id === payload.properties.sessionID)?.directory
    : undefined
  let sessionMove: SessionMove | null = null
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
    case "message.compaction.delta":
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
  const reducerResult = applyDirectoryEvent(draft, payload, {
    onCatalogUpdated: (kind) => scheduleCatalogReload(kind, childStores, resolvedDirectory),
    onLoadMcp: () => scheduleMcpStatusRefresh(resolvedDirectory),
  })
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization
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
    fileTreeChanges.toolTransition(resolvedDirectory, previousPart, updatedPart)
  }
  if (payload.type === "message.patched" && payload.properties.patch.time?.completed !== undefined) {
    const { sessionID, patch } = payload.properties
    if (patch.shell) {
      if (reducerChanged) fileTreeChanges.unknownChange(resolvedDirectory)
    } else if (patch.finish !== undefined) {
      fileTreeChanges.stepCompleted(resolvedDirectory, sessionID, patch.snapshot?.files)
    }
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
    const destinationDirectory = payload.type === "session.patched" ? payload.properties.patch.directory : undefined
    if (
      eventSessionID
      && destinationDirectory
      && directoryBeforePatch
      && normalizeEventDirectory(destinationDirectory) !== normalizeEventDirectory(directoryBeforePatch)
      && expectedRuntimeKey === getRuntimeKey()
    ) {
      sessionMove = { sessionID: eventSessionID, from: resolvedDirectory, to: destinationDirectory }
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

    if (sessionID && messageID && payload.type === "message.updated") {
      const after = getDirectoryEventState(store, batch)
      const { info } = payload.properties
      if (
        info.role === "assistant"
        && info.time.completed !== undefined
        && !Object.prototype.hasOwnProperty.call(after.part, messageID)
      ) {
        enqueueSessionMaterialization(resolvedDirectory, sessionID, childStores, {
          reason: "empty-assistant-message",
          messageID,
        })
      }
      if (info.role === "assistant" && typeof info.time.completed === "number") {
        maybePollStatusAfterMessageCompletion(resolvedDirectory, store, sessionID)
      }
    }
  } else {
    const sessionID = syncEventSessionID(payload)
    const messageID = syncEventMessageID(payload)
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

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
    const stopped = payload.type === "session.error" || payload.properties.outcome === "interrupted"
    if (sessionID && stopped) {
      const failure = payload.type === "session.error" ? payload.properties.error : undefined
      const interrupted = interruptedTurnToolParts(state, sessionID, Date.now(), failure)
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

  deliverSessionMove(sessionMove ?? globalSessionMove(payload, globalMoveSource), batch)
}

function globalSessionMove(payload: SyncEvent, from: string | null): SessionMove | null {
  if (payload.type !== "session.patched" || !from) return null
  const to = payload.properties.patch.directory
  if (!to || normalizeEventDirectory(to) === normalizeEventDirectory(from)) return null
  return { sessionID: payload.properties.sessionID, from, to }
}

function deliverSessionMove(move: SessionMove | null, batch: DirectoryEventBatch | undefined): void {
  if (!move) return
  if (batch) batch.sessionMoves.push(move)
  else adoptSessionMove(move.sessionID, move.from, move.to)
}

// external: https://github.com/anomalyco/opencode/issues/19023 Explicit turn-end evidence repairs assistant messages and tools that OpenCode leaves unfinished.
export function interruptedTurnToolParts(
  state: DirectoryStore,
  sessionID: string,
  now = Date.now(),
  failure?: StructuredError,
  recordedInterruption = false,
): { messageID: string; messages: Message[]; parts?: Part[] } | null {
  if ((state.form?.[sessionID] ?? []).length > 0) return null
  if ((state.permission?.[sessionID] ?? []).length > 0) return null
  const status = state.session_status?.[sessionID]
  if (status && status.type !== "idle") return null

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
  const completed = message.time.completed !== undefined
  if (completed && !recordedInterruption) {
    return null
  }

  const messageID = message.id
  const nextMessages = completed ? messages : [...messages]
  const error: StructuredError = failure ?? { type: "aborted", message: "aborted" }
  if (!completed) nextMessages[messageIndex] = {
    ...message,
    time: { ...message.time, completed: now },
    error,
    closedLocally: true,
  }

  let partsChanged = false
  const currentParts = state.part[messageID]
  const nextParts = currentParts?.map((part): Part => {
    if (part.type !== "tool") return part
    if (recordedInterruption && part.state.status === "error" && part.state.error === "Interrupted"
      && part.state.errorSource === undefined && part.state.errorType === undefined) {
      partsChanged = true
      return { ...part, state: { ...part.state, errorSource: "local" } }
    }
    if (part.state.status !== "pending" && part.state.status !== "running") return part
    partsChanged = true
    const start = part.state.status === "running" ? part.state.time.start : now
    return {
      ...part,
      state: {
        ...part.state,
        status: "error",
        error: "Interrupted",
        errorSource: "local",
        time: { start, end: now },
      },
    }
  })

  if (completed && !partsChanged) return null
  return {
    messageID,
    messages: nextMessages,
    parts: partsChanged ? nextParts : undefined,
  }
}

function recordedTurnEnd(
  state: DirectoryStore,
  sessionID: string,
): { outcome: SessionOutcome; error?: StructuredError } | undefined {
  const messages = state.message[sessionID] ?? []
  let end: { outcome: SessionOutcome; error?: StructuredError } | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return undefined
    if (message.role === "assistant") return end
    if (message.role === "idle") end ??= { outcome: message.outcome, error: message.error }
  }
  return undefined
}

export function markRecordedInterruptedTurn(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const state = store.getState()
  const end = recordedTurnEnd(state, sessionID)
  if (end?.outcome !== "interrupted" && end?.outcome !== "failed") return
  const interrupted = interruptedTurnToolParts(state, sessionID, Date.now(), end.outcome === "failed" ? end.error : undefined, true)
  if (!interrupted) return

  const interruptedParts = interrupted.parts
  if (!interruptedParts) {
    store.setState((current) => ({
      message: { ...current.message, [sessionID]: interrupted.messages },
    }))
    return
  }

  store.setState((current) => ({
    message: { ...current.message, [sessionID]: interrupted.messages },
    part: { ...current.part, [interrupted.messageID]: interruptedParts },
  }))
}


const listSessionPage: SessionPageLister = (options) => opencodeClient.listSessionsPage(options)

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

const followCurrentChatToArchive = (goneIds: ReadonlySet<string>): boolean => {
  const ui = useSessionUIStore.getState()
  const current = normalizePath(ui.currentSessionDirectory)
  const spaceId = spaceIdOfDirectory(current)
  if (!ui.currentSessionId || spaceId === null || !goneIds.has(spaceId)) return true
  const archived = normalizePath(useGlobalSessionsStore.getState().entityById.get(ui.currentSessionId)?.directory)
  if (!archived || archived === current) return false
  ui.setSessionDirectory(ui.currentSessionId, archived)
  return true
}

type SyncStores = { childStores: ChildStoreManager; messageLoader: SessionMessageLoader }

const createSyncStores = (): SyncStores => {
  const childStores = new ChildStoreManager({ seedsSessions: isDirectoryOfKnownSpace })
  return {
    childStores,
    messageLoader: new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() }, openCodeStartupSignal),
  }
}

let syncStoresMadeBeforeMount: SyncStores | null = null

export function prefetchSessionBeforeMount(target: SessionMessageTarget): void {
  syncStoresMadeBeforeMount ??= createSyncStores()
  void syncStoresMadeBeforeMount.messageLoader.prefetch(target)
}

export function SyncProvider(props: {
  sdk: OpenCodeClient
  directory: string
  children: React.ReactNode
}) {
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const syncStoresRef = useRef<SyncStores | null>(null)
  if (!syncStoresRef.current) syncStoresRef.current = syncStoresMadeBeforeMount ?? createSyncStores()
  const { childStores, messageLoader } = syncStoresRef.current
  useEffect(() => {
    if (syncStoresMadeBeforeMount === syncStoresRef.current) syncStoresMadeBeforeMount = null
  }, [])
  useEffect(() => {
    const noteLoadedAnswers = () => {
      for (const store of childStores.children.values()) noteDeferredAnswersLoaded(store.getState().message)
    }
    noteLoadedAnswers()
    return childStores.subscribeAllSelected((state) => state.message, noteLoadedAnswers)
  }, [childStores])
  const runtimeKey = getRuntimeKey()
  const messageLoaderDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  messageLoader.configure({ sdk: opencodeClient, runtimeKey })
  useEffect(() => {
    opencodeClient.learnMessagePageShellsSupport()
  }, [runtimeKey])
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const currentDirectoryRef = useRef(props.directory)
  currentDirectoryRef.current = props.directory
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
  const locationReleaseRef = useRef<LocationRelease | null>(null)
  const previousDirectoryRef = useRef(props.directory)
  useEffect(() => {
    const expectedRuntimeKey = getRuntimeKey()
    const sdkEpoch = opencodeClient.getSdkClient()
    const release = createRealLocationRelease({
      releaseDelayMs: (directory) => {
        if (isChatDirectoryPath(directory)) return CHAT_LOCATION_RELEASE_DELAY_MS
        if (isWorktreeDirectory(directory, useSessionUIStore.getState().availableWorktreesByProject)) {
          return WORKTREE_LOCATION_RELEASE_DELAY_MS
        }
        return PROJECT_LOCATION_RELEASE_DELAY_MS
      },
      isCurrentDirectory: (directory) => directory === currentDirectoryRef.current,
      directoryUse: (directory) => isDirectoryExternallyViewed(directory)
        ? "busy"
        : directoryUse(directory, childStores.getChild(directory)?.getState()),
      release: async (directory) => {
        if (getRuntimeKey() !== expectedRuntimeKey || opencodeClient.getSdkClient() !== sdkEpoch) return
        await opencodeClient.releaseLocation(directory)
      },
    })
    locationReleaseRef.current = release
    const unsubscribeAssistSettled = subscribeSessionAssistSettled((isSettledDirectory) => release.recheck(isSettledDirectory))
    return () => {
      unsubscribeAssistSettled()
      release.dispose()
      if (locationReleaseRef.current === release) locationReleaseRef.current = null
    }
  }, [childStores, props.sdk])
  useEffect(() => {
    const previous = previousDirectoryRef.current
    previousDirectoryRef.current = props.directory
    locationReleaseRef.current?.directoryChanged(previous, props.directory)
  }, [props.directory])
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const statusPollBackoffByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const childDiscoveryDueAtByDirectoryRef = useRef(new Map<string, number>())
  const staleResyncBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
  const childDiscoveryBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
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

  useEffect(() => {
    staleResyncBackoffByDirectoryRef.current = new Map()
    childDiscoveryBackoffByDirectoryRef.current = new Map()
  }, [childStores, props.sdk, runtimeKey])

  const replayResyncDirectoriesRef = useRef(new Map<string, SessionMaterializationReason | null>())
  const triggerDirectoryResyncRef = useRef<(directory: string, reason: SessionMaterializationReason) => void>(() => undefined)
  const triggerDirectoryResync = useCallback((directory: string, reason: SessionMaterializationReason) => {
    const store = childStores.children.get(directory)
    if (!store) return
    const staleResyncBackoff = staleResyncBackoffByDirectoryRef.current
    if (reason === "stale-status-resync" && Date.now() < (staleResyncBackoff.get(directory)?.retryAt ?? 0)) return
    const resyncing = resyncingDirectoriesRef.current
    const replayResyncs = replayResyncDirectoriesRef.current
    if (resyncing.has(directory)) {
      if (replayResyncs.has(directory) && reason !== "stream-replayed") replayResyncs.set(directory, reason)
      return
    }
    if (reason === "stream-replayed") replayResyncs.set(directory, null)

    if (reason !== "stream-replayed") lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    resyncing.add(directory)
    const sdk = opencodeClient.getSdkClient()
    const expectedRuntimeKey = getRuntimeKey()
    const isStale = () => getRuntimeKey() !== expectedRuntimeKey
      || opencodeClient.getSdkClient() !== sdk || childStores.children.get(directory) !== store
      || staleResyncBackoffByDirectoryRef.current !== staleResyncBackoff
    void resyncDirectoryAfterReconnect(directory, store, routingIndex, reason, isStale)
      .then((succeeded) => {
        if (isStale()) return
        if (succeeded) staleResyncBackoff.delete(directory)
        else recordWatchdogReadFailure(staleResyncBackoff, directory, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS)
      })
      .catch(() => {
        if (!isStale()) recordWatchdogReadFailure(staleResyncBackoff, directory, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS)
      })
      .finally(() => {
        resyncing.delete(directory)
        const queued = replayResyncs.get(directory)
        replayResyncs.delete(directory)
        if (queued && !isStale()) triggerDirectoryResyncRef.current(directory, queued)
      })
  }, [childStores, routingIndex])
  useEffect(() => {
    triggerDirectoryResyncRef.current = triggerDirectoryResync
  }, [triggerDirectoryResync])

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

  useEffect(() => {
    const onReturn = () => {
      if (dormantLocations.size > 0 && isUiFocused()) wakeDormantLocations(childStores, currentDirectoryRef.current)
    }
    window.addEventListener("focus", onReturn)
    document.addEventListener("visibilitychange", onReturn)
    return () => {
      window.removeEventListener("focus", onReturn)
      document.removeEventListener("visibilitychange", onReturn)
      dormantLocations.clear()
    }
  }, [childStores])

  useEffect(() => {
    void usePermissionStore.getState().hydrate().catch(() => undefined)
    void useMessageQueueStore.getState().hydrate().catch(() => undefined)
    if (isAutoReviewAvailable()) void useAutoReviewStore.getState().hydrate().catch(() => undefined)
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
            loadSessions: async (dir) => {
              if (!isCurrent()) return
              const baselineRevision = store.getState().sessionRevision ?? 0
              const { active } = splitGlobalSessionsByArchived(
                await listGlobalSessionPages(listSessionPage, {
                  directory: dir,
                  pageSize: 500,
                  onPage: (page) => {
                    if (!isCurrent()) return
                    const { active } = splitGlobalSessionsByArchived(page)
                    const current = store.getState()
                    const { sessions } = mergeBootstrapSessions(
                      active.filter((session) => !session.parentID), active, current.session, {
                        baselineRevision,
                        partial: true,
                        eventRevision: current.sessionEventRevision,
                        deletedRevision: current.sessionDeletedRevision,
                      },
                    )
                    if (sessions === current.session) return
                    store.setState({ session: sessions, limit: Math.max(sessions.length, 50) })
                    ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
                  },
                }),
              )
              const allSessions = active
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const rootSessions = allSessions.filter((s) => !s.parentID)
              if (!isCurrent()) return

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

        if (result === "complete") {
          useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()
        }
      },
      onDispose: (directory) => {
        messageLoader.invalidateDirectory(directory)
        lastStatusPollAtByDirectoryRef.current.delete(directory)
        statusPollBackoffByDirectoryRef.current.delete(directory)
        lastFullResyncAtByDirectoryRef.current.delete(directory)
        childDiscoveryDueAtByDirectoryRef.current.delete(directory)
        staleResyncBackoffByDirectoryRef.current.delete(directory)
        childDiscoveryBackoffByDirectoryRef.current.delete(directory)
      },
      isLoadingSessions: () => false,
    })
  }, [childStores, messageLoader, props.sdk, routingIndex])

  useEffect(() => {
    let previous = knownSpaceIds(useSpacesStore.getState())
    let generation = spacesRuntimeGeneration()
    return useSpacesStore.subscribe((state) => {
      const next = knownSpaceIds(state)
      const reset = spacesRuntimeGeneration() !== generation
      generation = spacesRuntimeGeneration()
      const gone = reset ? [] : spaceIdsGone(previous, next)
      previous = next
      if (gone.length === 0) return
      const goneIds = new Set(gone)
      for (const directory of Array.from(childStores.children.keys())) {
        const spaceId = spaceIdOfDirectory(directory)
        if (spaceId !== null && goneIds.has(spaceId)) childStores.forgetDirectory(directory)
      }
      if (followCurrentChatToArchive(goneIds)) return
      const unsubscribe = useGlobalSessionsStore.subscribe(() => {
        if (followCurrentChatToArchive(goneIds)) unsubscribe()
      })
    })
  }, [childStores])

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

  useEffect(() => {
    const unsubscribeQueueEvents = subscribeMessageQueueSync(runtimeKey)
    const unsubscribeSessionAdmission = subscribeSessionAdmission()
    const unsubscribeAutoReviewEvents = subscribeAutoReviewSync(runtimeKey)
    const unsubscribePrWatchEvents = subscribePrWatchSync(runtimeKey)
    const unsubscribeExtensionWaitEvents = subscribeExtensionWaitsSync(runtimeKey)
    const unsubscribeLaterPageEvents = subscribeLaterPagesSync(runtimeKey)
    const unsubscribeSessionWarming = subscribeSessionWarmingSync(runtimeKey)
    const unsubscribeSessionTodos = subscribeSessionTodosSync(runtimeKey)
    const unsubscribeFolderEvents = subscribeSessionFoldersSync(runtimeKey)
    const unsubscribeDraftEvents = subscribeSessionDraftsSync(runtimeKey)
    const unsubscribeSpaceModes = subscribeSpacePermissionModes(runtimeKey)
    const unsubscribePermissionPolicy = subscribePermissionPolicySync(
      runtimeKey,
      (event) => handleEvent("global", event, childStores, routingIndex, runtimeKey),
    )
    const unsubscribeControlStream = subscribeControlStreamSync(runtimeKey, (event) => {
      if (event.type === "session.patched") handleEvent("global", event, childStores, routingIndex, runtimeKey)
      else applyControlStreamOnlyEvent(event)
    })
    const unsubscribeSpaceCatalogs = subscribeSpaceCatalogs(runtimeKey)
    const unsubscribeSpaceSessionProject = subscribeSpaceSessionProject(runtimeKey)
    const resyncAfterStreamGap = (reason: SessionMaterializationReason) => {
      messageLoader.markHistoryStale()
      const gapEndedAt = Date.now()
      for (const dir of childStores.children.keys()) {
        triggerDirectoryResync(dir, reason)
        childDiscoveryDueAtByDirectoryRef.current.set(dir, gapEndedAt)
      }
      void reconcileActivityAfterGap(childStores)
      notifyStreamGap(runtimeKey)
    }
    const pipeline = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onStreamActivity: () => {
        lastStreamActivityAtRef.current = Date.now()
      },
      onEvents: (directory, payloads) => {
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
      onSpaceStream: ({ spaceId, status }) => {
        useSpacesStore.getState().noteStream(spaceId, status)
        if (status === "connected" && isSpaceStopped(spaceId)) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        if (status !== "connected") {
          if (useSpacesStore.getState().journey?.get(spaceId)?.state === "running") {
            void refreshSpacesJourney().catch(() => undefined)
          }
          return
        }
        const directories = Array.from(useGlobalSessionsStore.getState().sessionsByDirectory.keys())
          .filter((directory) => spaceIdOfDirectory(directory) === spaceId)
        const spaceDirectory = useSpacesStore.getState().spaces.get(spaceId)?.directory
        if (spaceDirectory) directories.push(spaceDirectory)
        if (directories.length === 0) return
        void useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories).catch(() => undefined)
      },
      onSpaceProgress: (progress) => {
        const known = useSpacesStore.getState().noteProgress(progress)
        if (known && progress.step !== "ready" && progress.step !== "failed") return
        void refreshSpacesJourney().catch(() => undefined)
      },
      onSpaceTaskTitle: (spaceId, taskTitle) => {
        if (runtimeKey !== getRuntimeKey()) return
        if (!useSpacesStore.getState().noteTaskTitle(spaceId, taskTitle)) void refreshSpacesJourney().catch(() => undefined)
      },
      onSpaceSetup: () => {
        void refreshSpacesJourney().catch(() => undefined)
      },
      onSpacePermissionStream: (spaceId) => {
        if (runtimeKey !== getRuntimeKey()) return
        void usePermissionStore.getState().refreshSpaceModes(spaceId)
      },
      onReconnect: ({ replayReset, replayed }) => {
        if (useUIStore.getState().isolatedSpacesEnabled && !isVSCodeRuntime()) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        renewWatchedFiles()
        void runBackgroundNetworkTask(() => refreshBackgroundImages(() => opencodeClient.listRunningImageJobs()))
          .catch(() => undefined)
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
        if (replayed) {
          for (const dir of childStores.children.keys()) triggerDirectoryResync(dir, "stream-replayed")
          void reconcileActivityAfterGap(childStores)
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
      unsubscribeSessionAdmission()
      unsubscribeAutoReviewEvents()
      unsubscribePrWatchEvents()
      unsubscribeExtensionWaitEvents()
      unsubscribeLaterPageEvents()
      unsubscribeSessionWarming()
      unsubscribeSessionTodos()
      unsubscribeFolderEvents()
      unsubscribeDraftEvents()
      unsubscribeSpaceModes()
      unsubscribePermissionPolicy()
      unsubscribeControlStream()
      unsubscribeSpaceCatalogs()
      unsubscribeSpaceSessionProject()
    }
  }, [props.sdk, childStores, messageLoader, routingIndex, messageStreamTransport, runtimeKey, triggerDirectoryResync])

  useEffect(() => {
    let stopped = false
    let running = false
    const statusPollBackoff = new Map<string, number>()
    statusPollBackoffByDirectoryRef.current = statusPollBackoff
    const staleResyncBackoff = staleResyncBackoffByDirectoryRef.current
    const childDiscoveryBackoff = childDiscoveryBackoffByDirectoryRef.current

    const discoverChildSessions = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      parentSessionIds: string[],
    ) => {
      if (parentSessionIds.length === 0) return
      if (childDiscoveryDirectories.has(directory)) return
      childDiscoveryDirectories.add(directory)
      try {
        const listed: GlobalSessionRecord[] = []
        for (const parentID of parentSessionIds) {
          listed.push(...await listGlobalSessionPages(listSessionPage, { directory, parentID, pageSize: 200 }))
          if (stopped || childStores.getChild(directory) !== store) return
        }
        const { active: allSessions } = splitGlobalSessionsByArchived(listed)
        childDiscoveryBackoff.delete(directory)
        const state = store.getState()
        const globalEntities = useGlobalSessionsStore.getState().entityById
        const newChildSessions = selectNewChildSessions(
          allSessions,
          new Set(state.session.map((s) => s.id)),
          new Set(parentSessionIds),
          (sessionId) => Boolean(globalEntities.get(sessionId)?.time?.archived),
        )
        if (newChildSessions.length === 0) return
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
        for (const pid of parentIdsForMaterialization) {
          enqueueSessionMaterialization(directory, pid, childStores, { reason: "child-session-discovered" })
        }
      } catch {
        if (!stopped && childStores.getChild(directory) === store) {
          recordWatchdogReadFailure(childDiscoveryBackoff, directory, CHILD_SESSION_DISCOVERY_RETRY_MS)
          childDiscoveryDueAtByDirectoryRef.current.set(directory, Date.now())
        }
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
      const recordFailure = () => {
        if (stopped || childStores.getChild(directory) !== store) return
        const previousDelay = statusPollBackoff.get(directory) ?? ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS
        statusPollBackoff.set(directory, Math.min(previousDelay * 2, ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS))
        lastStatusPollAtByDirectoryRef.current.set(directory, Date.now())
      }
      try {
        const before = store.getState()
        const statuses = await runBackgroundNetworkTask(() => resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "monotonic"), "active-session")
        if (statuses === undefined) return
        if (statuses === null) {
          recordFailure()
          return
        }
        if (stopped || childStores.getChild(directory) !== store) return
        statusPollBackoff.delete(directory)
        const needsSnapshot = candidateSessionIds.some((sessionId) => (
          needsSnapshotAfterStatusPoll(before, sessionId, statuses[sessionId])
        ))
        if (needsSnapshot) {
          triggerDirectoryResync(directory, "stale-status-resync")
        }
      } catch {
        recordFailure()
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
            if (isSpaceDirectoryStopped(directory)) continue
            const state = store.getState()
            const candidateSessionIds = getActiveSessionCandidateIds(directory, state)
            if (candidateSessionIds.length === 0) {
              lastStatusPollAtByDirectoryRef.current.delete(directory)
              statusPollBackoff.delete(directory)
              lastFullResyncAtByDirectoryRef.current.delete(directory)
              staleResyncBackoff.delete(directory)
              childDiscoveryBackoff.delete(directory)
              const childDiscoveryDueAt = childDiscoveryDueAtByDirectoryRef.current.get(directory)
              if (childDiscoveryDueAt !== undefined && now - childDiscoveryDueAt >= CHILD_SESSION_DISCOVERY_WAIT_MS) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
              }
              continue
            }

            const liveSessionIds = getLiveSessionCandidateIds(state)
            const lastStatusPollAt = lastStatusPollAtByDirectoryRef.current.get(directory) ?? 0
            const streamHealthy = now - lastStreamActivityAtRef.current < ACTIVE_SESSION_STALE_EVENT_MS
            const statusPollInterval = statusPollBackoff.get(directory)
              ?? (streamHealthy ? ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS : ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS)
            if (liveSessionIds.length > 0 && now - lastStatusPollAt >= statusPollInterval) {
              lastStatusPollAtByDirectoryRef.current.set(directory, now)
              void pollDirectoryStatuses(directory, store, liveSessionIds).catch(() => undefined)
            }

            const lastFullResyncAt = lastFullResyncAtByDirectoryRef.current.get(directory) ?? 0
            if (now >= (staleResyncBackoff.get(directory)?.retryAt ?? 0)
              && shouldTriggerStaleResync(lastStreamActivityAtRef.current, lastFullResyncAt, now)) {
              pipelineReconnectRef.current?.("active_stream_stale")
              triggerDirectoryResync(directory, "stale-status-resync")
              childDiscoveryDueAtByDirectoryRef.current.set(directory, now)
            }

            const childDiscoveryDueAt = childDiscoveryDueAtByDirectoryRef.current.get(directory)
            if (
              childDiscoveryDueAt !== undefined
              && !childDiscoveryDirectories.has(directory)
              && now >= (childDiscoveryBackoff.get(directory)?.retryAt ?? 0)
            ) {
              if (liveSessionIds.length > 0) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
                void discoverChildSessions(directory, store, liveSessionIds)
              } else if (now - childDiscoveryDueAt >= CHILD_SESSION_DISCOVERY_WAIT_MS) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
              }
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
  }, [childStores, props.sdk, triggerDirectoryResync, runtimeKey])

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
      messageLoaderDisposalTimerRef.current = setTimeout(() => {
        messageLoaderDisposalTimerRef.current = null
        messageLoader.dispose()
        childStores.disposeAll()
      }, 0)
    }
  }, [childStores, messageLoader])

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

  return (
    <SyncContext.Provider value={system}>
      <SyncRuntimeContext.Provider value={runtime}>
        {props.children}
      </SyncRuntimeContext.Provider>
    </SyncContext.Provider>
  )
}


export function useDirectoryStore(
  directory?: string,
  options?: {
    bootstrap?: boolean
    priority?: DirectoryBootstrapPriority
    reason?: DirectoryBootstrapReason
  },
): StoreApi<DirectoryStore> {
  const runtime = useSyncRuntime()
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

export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

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

export function useSessionStatusSnapshotReady(directory?: string, sessionID?: string): boolean {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    return state.sessionStatusReady === true && (!sessionID || !state.sessionStatusInvalidated?.[sessionID])
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.sessionStatusReady !== previous.sessionStatusReady
      || (sessionID && state.sessionStatusInvalidated?.[sessionID] !== previous.sessionStatusInvalidated?.[sessionID])) notify()
  }), [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

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

type SessionBlockingRequests = {
  hasPermission: boolean
  hasForm: boolean
}

const NO_SESSION_BLOCKING_REQUESTS: SessionBlockingRequests = {
  hasPermission: false,
  hasForm: false,
}

export function useSessionBlockingRequests(
  scopes: readonly { directory: string; sessionIDs: readonly string[] }[],
): SessionBlockingRequests {
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
  const snapshotRef = useRef(NO_SESSION_BLOCKING_REQUESTS)
  const getSnapshot = React.useCallback(() => {
    let hasPermission = false
    let hasForm = false
    const indexed = useGlobalBlockingRequestsStore.getState().bySession
    for (const { sessionIDs, store } of scopedStores) {
      const { permission: permissions, form: forms, status } = store.getState()
      const storeAuthoritative = status === "complete"
      for (const sessionID of sessionIDs) {
        const pending = indexed.get(sessionID)
        hasPermission ||= Boolean(permissions[sessionID]?.length)
          || (!storeAuthoritative && Boolean(pending?.permissions.length))
        hasForm ||= Boolean(forms[sessionID]?.length)
          || Boolean(pending?.pages.length)
          || (!storeAuthoritative && Boolean(pending?.forms.length))
      }
    }
    const previous = snapshotRef.current
    if (previous.hasPermission === hasPermission && previous.hasForm === hasForm) {
      return previous
    }
    const next = { hasPermission, hasForm }
    snapshotRef.current = next
    return next
  }, [scopedStores])
  const subscribe = React.useCallback((notify: () => void) => {
    const unsubscribers = [
      ...scopedStores.flatMap(({ sessionIDs, store }) => [
        subscribeDirectoryPermissions(store, sessionIDs, notify),
        subscribeDirectoryForms(store, sessionIDs, notify),
      ]),
      useGlobalBlockingRequestsStore.subscribe(notify),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [scopedStores])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const sessionStartTimesCache = new WeakMap<State["session"], ReadonlyMap<string, number>>()

const readSessionStartTimes = (sessions: State["session"]): ReadonlyMap<string, number> => {
  let startTimes = sessionStartTimesCache.get(sessions)
  if (!startTimes) {
    startTimes = new Map(sessions.map((session) => [session.id, session.time.created]))
    sessionStartTimesCache.set(sessions, startTimes)
  }
  return startTimes
}

const haveSameStartTimes = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean => {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [sessionID, created] of left) {
    if (right.get(sessionID) !== created) return false
  }
  return true
}

export function useSessionStartTimes(directory?: string): ReadonlyMap<string, number> {
  const store = useDirectoryStore(directory)
  const cacheRef = useRef<ReadonlyMap<string, number> | null>(null)
  const getSnapshot = useCallback(() => {
    const next = readSessionStartTimes(store.getState().session)
    const cached = cacheRef.current
    if (cached && haveSameStartTimes(cached, next)) return cached
    cacheRef.current = next
    return next
  }, [store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.session !== previous.session) notify()
  }), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectPermissionRequestsBySession = (state: State) => state.permission
const selectFormRequestsBySession = (state: State) => state.form

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

export function useRecoveredQuestions(sessionID: string | null, directory?: string): RecoveredQuestion[] {
  const store = useDirectoryStore(directory)
  const sessions = useStore(store, (state) => state.session)
  const form = useStore(store, (state) => state.form)
  const part = useStore(store, (state) => state.part)
  const recovery = useRecoverableQuestionsStore()
  return useMemo(() => deriveRecoveredQuestions(
    { form, part },
    recovery,
    sessionID ? computeSubtreeIds(sessions, sessionID) : new Set<string>(),
  ), [form, part, recovery, sessionID, sessions])
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

export function useSessionSelector<T>(
  sessionID: string | null | undefined,
  directory: string | undefined,
  select: (session: Session | undefined) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const { childStores } = useSyncRuntime()
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    let session: Session | undefined
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      session = sessions ? getSessionById(sessions, sessionID) : undefined
    } else {
      session = findLiveSession(getLiveStates(childStores), sessionID)
    }
    const next = select(session)
    const cached = cacheRef.current
    if (cached && isEqual(cached.value, next)) return cached.value
    cacheRef.current = { value: next }
    return next
  }, [childStores, directory, isEqual, select, sessionID])

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

const selectSessionDirectory = (session: Session | undefined): string | undefined => session?.directory ?? undefined

export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  return useSessionSelector(sessionID, directory, selectSessionDirectory)
}

export function useSyncDirectory() {
  return useSyncSystem().directory
}

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

const getSessionRevertMessageID = (sessions: State["session"], sessionID: string): string | undefined => {
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

const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_FORM_REQUESTS: FormRequest[] = []
