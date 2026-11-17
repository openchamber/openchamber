import React, { useEffect, useRef, useCallback } from "react"
import type { SyncRuntime } from "./sync-runtime-context"
import { type SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager } from "./child-store"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { type DirectoryReadBackoff, recordWatchdogReadFailure, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS } from "./sync-watchdog-policy"
import { type EventRoutingIndex } from "./event-routing-index"
import { resyncDirectoryAfterReconnect } from "./session-reconnect-recovery"
import { resyncBlockingRequestsForActiveDirectory } from "./blocking-request-recovery"
import { dormantLocations, wakeDormantLocations } from "./dormant-locations"
import { isUiFocused } from "./surface-notifications"

export function useDirectoryResync({
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
}: {
  staleResyncBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
  childDiscoveryBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
  childStores: ChildStoreManager
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  runtimeKey: string
  resyncingDirectoriesRef: React.RefObject<Set<string>>
  lastFullResyncAtByDirectoryRef: React.RefObject<Map<string, number>>
  routingIndex: EventRoutingIndex
  currentDirectoryRef: React.RefObject<string>
  blockingRequestResyncingDirectoriesRef: React.RefObject<Set<string>>
}) {
  useEffect(() => {
    staleResyncBackoffByDirectoryRef.current = new Map()
    childDiscoveryBackoffByDirectoryRef.current = new Map()
  }, [childStores, props.sdk, runtimeKey, staleResyncBackoffByDirectoryRef, childDiscoveryBackoffByDirectoryRef])
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
  }, [childStores, routingIndex, staleResyncBackoffByDirectoryRef, resyncingDirectoriesRef, lastFullResyncAtByDirectoryRef])
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
  }, [childStores, currentDirectoryRef, blockingRequestResyncingDirectoriesRef])
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
  }, [childStores, currentDirectoryRef])
  return { triggerDirectoryResync }
}
