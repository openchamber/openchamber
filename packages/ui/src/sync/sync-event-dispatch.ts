import { syncEventMessageID, syncEventSessionID, type SyncEvent } from "@/lib/opencode/events"
import type { PermissionRequest } from "@/lib/opencode/model"
import { isVSCodeRuntime } from "@/lib/desktop"
import { reduceGlobalEvent, applyDirectoryEvent } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, markDirectorySessionPartChanged, type DirectoryStore } from "./child-store"
import { touchStreamingSession } from "./streaming"
import { countSyncPerformance } from "./performance-diagnostics"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { applyRecoverableQuestionEvents } from "./recoverable-questions"
import { adoptSessionMove } from "./session-actions"
import { applySessionEventToGlobalSessions } from "./session-event-router"
import { shouldConsumeBulkArchiveEcho } from "./bulk-archive-echo"
import { applyForkedSession, noteForkedSessionPatched } from "./forked-session"
import { useBtwStore } from "@/stores/useBtwStore"
import { syncDebug } from "./debug"
import { normalizePath } from "@/lib/pathNormalization"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { policySnapshotFromWire } from "@/stores/utils/permissionAutoAccept"
import { useRoutingStore } from "@/stores/useRoutingStore"
import { processVSCodePermissionAutoAccept } from "./vscode-permission-auto-accept"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { toast } from "@/components/ui"
import { applyGlobalSessionStatusEvent } from "./global-session-status"
import { applyGlobalBlockingRequestEvents } from "./global-blocking-requests"
import { applyBackgroundShellEvents, directoriesWithRunningShells, refreshBackgroundShells } from "./background-shells"
import { applyBackgroundImageEvents, refreshBackgroundImages } from "./background-images"
import { applySessionLiveWorkEvents } from "./session-live-work"
import { applyReplyCommandEvents } from "./reply-commands"
import type { State } from "./types"
import { getStaleRunningToolMessageID } from "./materialization"
import { getPermissionToastKey } from "./permission-toast"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { sessionEvents } from "@/lib/sessionEvents"
import { fileTreeChanges } from "@/lib/fileTreeChanges"
import { notifyWatchedFileChanged } from "@/lib/watchedFiles"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { claimFirstServerConnect, notifyFirstServerConnect } from "./first-server-connect"
import { type EventRoutingIndex, normalizeEventDirectory, resolveDirectoryFromRoutingIndex, resolveCachedSessionDirectory, findSessionInChildStores, updateRoutingIndexFromEvent, resolveMaterializationSessionID } from "./event-routing-index"
import { type DirectoryEventBatch, getDirectoryEventState, type SessionMove } from "./directory-event-batch"
import { handleUiNotificationEvent, isUiAway } from "./surface-notifications"
import { showPermissionLeftForUser, isHeldUntilAutoAnswered, recordTurnOutcomeNotification, forgetAutoAnswerWait, notifyBlockingRequestWithoutStore, getVSCodePermissionEventKey, pendingVSCodePermissionEvents, holdBackUntilAutoAnswered, notifyPermissionAsked, pendingPermissionToastIds, notifyFormCreated, getFormToastKey, pendingFormToastIds } from "./sync-request-notifications"
import { isControlStreamOnlyEvent } from "./sync-control-events"
import { forgetMcpStatus, dormantLocations, cancelMcpStatusRefresh, scheduleMcpStatusRefresh } from "./dormant-locations"
import { isRecentBoot } from "./sync-context"
import { scheduleCatalogReload } from "./sync-catalog-refresh"
import { reconcileActivityAfterGap } from "./session-reconnect-recovery"
import { enqueueSessionMaterialization } from "./session-materialization-recovery"
import { maybePollStatusAfterMessageCompletion } from "./session-status-recovery"
import { interruptedTurnToolParts } from "./interrupted-turn-recovery"

const isPartEvent = (type: SyncEvent["type"]): boolean => (
  type === "message.part.updated"
  || type === "message.part.delta"
  || type === "message.tool.transition"
  || type === "message.parts.replaced"
)

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
