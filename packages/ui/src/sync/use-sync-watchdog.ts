import React, { useEffect } from "react"
import type { StoreApi } from "zustand"
import type { SyncRuntime } from "./sync-runtime-context"
import { type SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { selectNewChildSessions } from "./child-session-discovery"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSpaceDirectoryStopped } from "@/lib/spaces/spaces-store"
import { listGlobalSessionPages, splitGlobalSessionsByArchived, type GlobalSessionRecord } from "@/stores/globalSessions"
import { type DirectoryReadBackoff, recordWatchdogReadFailure, CHILD_SESSION_DISCOVERY_RETRY_MS, ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS, ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS, CHILD_SESSION_DISCOVERY_WAIT_MS, ACTIVE_SESSION_STALE_EVENT_MS, ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS, shouldTriggerStaleResync, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS } from "./sync-watchdog-policy"
import { listSessionPage } from "./session-page-listing"
import { enqueueSessionMaterialization } from "./session-materialization-recovery"
import { statusPollingDirectories, resyncDirectorySessionStatuses, needsSnapshotAfterStatusPoll, getActiveSessionCandidateIds, getLiveSessionCandidateIds } from "./session-status-recovery"

const childDiscoveryDirectories = new Set<string>()

export function useSyncWatchdog({
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
}: {
  statusPollBackoffByDirectoryRef: React.RefObject<Map<string, number>>
  staleResyncBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
  childDiscoveryBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
  childStores: ChildStoreManager
  childDiscoveryDueAtByDirectoryRef: React.RefObject<Map<string, number>>
  lastStatusPollAtByDirectoryRef: React.RefObject<Map<string, number>>
  triggerDirectoryResync: (directory: string, reason: SessionMaterializationReason) => void
  lastFullResyncAtByDirectoryRef: React.RefObject<Map<string, number>>
  lastStreamActivityAtRef: React.RefObject<number>
  pipelineReconnectRef: React.RefObject<((reason?: string) => void) | null>
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  runtimeKey: string
}) {
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
  }, [
    childStores, props.sdk, triggerDirectoryResync, runtimeKey,
    childDiscoveryDueAtByDirectoryRef, lastStatusPollAtByDirectoryRef, staleResyncBackoffByDirectoryRef,
    lastStreamActivityAtRef, lastFullResyncAtByDirectoryRef, statusPollBackoffByDirectoryRef,
    pipelineReconnectRef, childDiscoveryBackoffByDirectoryRef,
  ])
}
