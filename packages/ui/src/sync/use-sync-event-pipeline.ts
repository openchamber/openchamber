import React, { useEffect } from "react"
import type { SyncRuntime } from "./sync-runtime-context"
import { type SyncEvent } from "@/lib/opencode/events"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { type SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager } from "./child-store"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { subscribeSessionAdmission } from "./session-admission"
import { useUIStore } from "@/stores/useUIStore"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
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
import { subscribeSpaceCatalogs } from "./space-catalog-sync"
import { subscribeSpaceSessionProject } from "./space-session-project"
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { isSpaceStopped, refreshSpacesJourney, useSpacesStore } from "@/lib/spaces/spaces-store"
import { refreshBackgroundImages } from "./background-images"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { renewWatchedFiles } from "@/lib/watchedFiles"
import { SessionMessageLoader } from "./session-message-loader"
import { notifyStreamGap } from "./stream-gap"
import { type EventRoutingIndex, resolveDirectoryFromRoutingIndex } from "./event-routing-index"
import { handleEvent } from "./sync-event-dispatch"
import { applyControlStreamOnlyEvent } from "./sync-control-events"
import { reconcileActivityAfterGap } from "./session-reconnect-recovery"
import { createDirectoryEventBatch, publishDirectoryEventBatch } from "./directory-event-batch"
import { isRecentBoot } from "./use-sync-bootstrap"

const SHOULD_DISPATCH_VSCODE_NOTIFICATIONS = isVSCodeRuntime()

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: SyncEvent) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
}

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

export function useSyncEventPipeline({
  runtimeKey,
  childStores,
  routingIndex,
  messageLoader,
  triggerDirectoryResync,
  childDiscoveryDueAtByDirectoryRef,
  props,
  messageStreamTransport,
  lastStreamActivityAtRef,
  currentDirectoryRef,
  pipelineHasConnectedRef,
  pipelineDisconnectedBeforeFirstConnectRef,
  pipelineReconnectRef,
}: {
  runtimeKey: string
  childStores: ChildStoreManager
  routingIndex: EventRoutingIndex
  messageLoader: SessionMessageLoader
  triggerDirectoryResync: (directory: string, reason: SessionMaterializationReason) => void
  childDiscoveryDueAtByDirectoryRef: React.RefObject<Map<string, number>>
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  messageStreamTransport: ReturnType<typeof useConfigStore.getState>["settingsMessageStreamTransport"]
  lastStreamActivityAtRef: React.RefObject<number>
  currentDirectoryRef: React.RefObject<string>
  pipelineHasConnectedRef: React.RefObject<boolean>
  pipelineDisconnectedBeforeFirstConnectRef: React.RefObject<boolean>
  pipelineReconnectRef: React.RefObject<((reason?: string) => void) | null>
}) {
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
  }, [
    props.sdk, childStores, messageLoader, routingIndex, messageStreamTransport, runtimeKey, triggerDirectoryResync,
    currentDirectoryRef, lastStreamActivityAtRef, pipelineReconnectRef,
    pipelineDisconnectedBeforeFirstConnectRef, pipelineHasConnectedRef, childDiscoveryDueAtByDirectoryRef,
  ])
}
