/* oxlint-disable react/only-export-components */
import "./sync-observers"
import React, { useMemo } from "react"
import type { OpenCodeClient } from "@opencode/client"
import { useSyncProviderState } from "./use-sync-provider-state"
import { useSyncLocationRelease } from "./use-sync-location-release"
import { useSyncRecoveryState } from "./use-sync-recovery-state"
import { type SyncRuntime, type SyncSystem, SyncContext, SyncRuntimeContext } from "./sync-runtime-context"
import { useDirectoryResync } from "./use-directory-resync"
import { useSyncBootstrap } from "./use-sync-bootstrap"
import { useSyncEventPipeline } from "./use-sync-event-pipeline"
import { useSyncWatchdog } from "./use-sync-watchdog"
import { useSyncDirectoryLifecycle } from "./use-sync-directory-lifecycle"

export function SyncProvider(props: {
  sdk: OpenCodeClient
  directory: string
  children: React.ReactNode
}) {
  const {
    messageStreamTransport,
    childStores,
    messageLoader,
    runtimeKey,
    messageLoaderDisposalTimerRef,
    routingIndex,
    currentDirectoryRef,
    currentDirectorySource,
  } = useSyncProviderState({ props })

  useSyncLocationRelease({ props, currentDirectoryRef, childStores })

  const {
    lastStreamActivityAtRef,
    lastStatusPollAtByDirectoryRef,
    statusPollBackoffByDirectoryRef,
    lastFullResyncAtByDirectoryRef,
    childDiscoveryDueAtByDirectoryRef,
    staleResyncBackoffByDirectoryRef,
    childDiscoveryBackoffByDirectoryRef,
    resyncingDirectoriesRef,
    blockingRequestResyncingDirectoriesRef,
    pipelineReconnectRef,
    pipelineHasConnectedRef,
    pipelineDisconnectedBeforeFirstConnectRef,
  } = useSyncRecoveryState()

  const runtime = useMemo<SyncRuntime>(
    () => ({ childStores, messageLoader, runtimeKey, sdk: props.sdk, currentDirectory: currentDirectorySource }),
    [childStores, currentDirectorySource, messageLoader, props.sdk, runtimeKey],
  )
  const system = useMemo<SyncSystem>(
    () => ({ ...runtime, directory: props.directory }),
    [props.directory, runtime],
  )

  const { triggerDirectoryResync } = useDirectoryResync({
    staleResyncBackoffByDirectoryRef,
    childDiscoveryBackoffByDirectoryRef,
    childStores,
    props,
    runtimeKey,
    resyncingDirectoriesRef,
    lastFullResyncAtByDirectoryRef,
    routingIndex,
    currentDirectoryRef,
    blockingRequestResyncingDirectoriesRef,
  })

  useSyncBootstrap({
    props,
    childStores,
    routingIndex,
    messageLoader,
    lastStatusPollAtByDirectoryRef,
    statusPollBackoffByDirectoryRef,
    lastFullResyncAtByDirectoryRef,
    childDiscoveryDueAtByDirectoryRef,
    staleResyncBackoffByDirectoryRef,
    childDiscoveryBackoffByDirectoryRef,
  })

  useSyncEventPipeline({
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
  })

  useSyncWatchdog({
    statusPollBackoffByDirectoryRef,
    staleResyncBackoffByDirectoryRef,
    childDiscoveryBackoffByDirectoryRef,
    childStores,
    childDiscoveryDueAtByDirectoryRef,
    lastStatusPollAtByDirectoryRef,
    triggerDirectoryResync,
    lastFullResyncAtByDirectoryRef,
    lastStreamActivityAtRef,
    pipelineReconnectRef,
    props,
    runtimeKey,
  })

  useSyncDirectoryLifecycle({ props, childStores, routingIndex, messageLoader, runtimeKey, messageLoaderDisposalTimerRef })

  return (
    <SyncContext.Provider value={system}>
      <SyncRuntimeContext.Provider value={runtime}>
        {props.children}
      </SyncRuntimeContext.Provider>
    </SyncContext.Provider>
  )
}

export { useSyncRuntime } from "./sync-runtime-context"
export { useAllSessionStatuses, useAllLiveSessions, useLiveSessionsExcluding, useSessions, useSessionStartTimes, useParentSession, useSession, useSessionSelector, useSessionDirectory } from "./live-session-hooks"
export { MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS, applySessionStatusSnapshot, maybePollStatusAfterMessageCompletion, needsSnapshotAfterStatusPoll } from "./session-status-recovery"
export { setActiveSession, setExternallyViewedSession } from "./viewed-sessions"
export { shouldTriggerStaleResync } from "./sync-watchdog-policy"
export { createEventRoutingIndex } from "./event-routing-index"
export { resyncBlockingRequestsForDirectory, resyncBlockingRequestsForActiveDirectory } from "./blocking-request-recovery"
export { reconcileActivityAfterGap } from "./session-reconnect-recovery"
export { wakeDormantLocations } from "./dormant-locations"
export { handleEvent } from "./sync-event-dispatch"
export { interruptedTurnToolParts, markRecordedInterruptedTurn } from "./interrupted-turn-recovery"
export { prefetchSessionBeforeMount } from "./use-sync-provider-state"
export { useDirectoryStore, useSessionMessageLoader, useSessionMessageLoadState, useDirectorySync, useSyncDirectory, useChildStoreManager } from "./directory-sync-hooks"
export { useSessionMessages, useSessionMessagesSelector, useSessionMessagesResolved, useSessionPartsForMessages, useSessionRenderable, useUserMessageHistory } from "./session-message-hooks"
export { useSessionStatus, useSessionStatusSnapshotReady, useSessionPermissions, useSessionBlockingRequests, collectComposerForms, useScopedBlockingPermissions, useScopedBlockingForms, useRecoveredQuestions } from "./session-request-hooks"
export { buildSessionMessageRecordsSnapshot, readSessionMessageRecordsSnapshot, useSessionMessageRecords } from "./session-message-records"
