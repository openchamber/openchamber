import React, { useEffect } from "react"
import type { SyncRuntime } from "./sync-runtime-context"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { updateChangedStreamingSessions, updateStreamingState } from "./streaming"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { opencodeClient } from "@/lib/opencode/client"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { SessionMessageLoader, getImperativeSessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"
import { type EventRoutingIndex, ingestDirectoryStateIntoRoutingIndex, setIndexedSessionDirectory } from "./event-routing-index"
import { _activeDirectory, _activeSession, externallyViewedSessions, viewedSessionKey } from "./viewed-sessions"
import { dropCachedSessionMessageRecordsSnapshots } from "./session-message-records"
import { enqueueSessionMaterialization } from "./session-materialization-recovery"

export function useSyncDirectoryLifecycle({
  props,
  childStores,
  routingIndex,
  messageLoader,
  runtimeKey,
  messageLoaderDisposalTimerRef,
}: {
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  childStores: ChildStoreManager
  routingIndex: EventRoutingIndex
  messageLoader: SessionMessageLoader
  runtimeKey: string
  messageLoaderDisposalTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>
}) {
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
  }, [childStores, messageLoader, messageLoaderDisposalTimerRef])
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
}
