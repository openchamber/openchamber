import type { StoreApi } from "zustand"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { countSyncPerformance } from "./performance-diagnostics"
import { syncDebug } from "./debug"
import { opencodeClient } from "@/lib/opencode/client"
import { getSessionMaterializationRequestKey, isSessionMaterializationStillNeeded, type SessionMaterializationRequest } from "./materialization"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { directorySessionMovedTo } from "./event-routing-index"
import { resyncDirectorySessionStatuses } from "./session-status-recovery"
import { markRecordedInterruptedTurn } from "./interrupted-turn-recovery"

const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30

type PendingSessionMaterialization = {
  runtimeKey: string
  sessionID: string
  directory: string
  enqueuedAt: number
  request: SessionMaterializationRequest
}

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000

const pendingSessionMaterializations = new Map<string, PendingSessionMaterialization>()

export function enqueueSessionMaterialization(
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
