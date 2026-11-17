import React, { useEffect } from "react"
import type { SyncRuntime } from "./sync-runtime-context"
import { isVSCodeRuntime } from "@/lib/desktop"
import { useGlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryBootstrapContext } from "./child-store"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { useSessionUIStore } from "./session-ui-store"
import { normalizePath } from "@/lib/pathNormalization"
import { mergeBootstrapSessions } from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { isAutoReviewAvailable, useAutoReviewStore } from "@/stores/useAutoReviewStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { knownSpaceIds, spaceIdsGone, spacesRuntimeGeneration, useSpacesStore } from "@/lib/spaces/spaces-store"
import { applyGlobalSessionStatusSnapshot, getDirectoryOwnedSessionIds } from "./global-session-status"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isFilesystemError } from "@/lib/api/files-errors"
import { listGlobalSessionPages, splitGlobalSessionsByArchived } from "@/stores/globalSessions"
import { SessionMessageLoader } from "./session-message-loader"
import { type EventRoutingIndex, ingestDirectoryStateIntoRoutingIndex } from "./event-routing-index"
import { type DirectoryReadBackoff } from "./sync-watchdog-policy"
import { listSessionPage } from "./session-page-listing"

let bootingRoot = false

let bootedAt = 0

let globalBootstrapGeneration = 0

const BOOT_DEBOUNCE_MS = 1500

export function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
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

export function useSyncBootstrap({
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
}: {
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  childStores: ChildStoreManager
  routingIndex: EventRoutingIndex
  messageLoader: SessionMessageLoader
  lastStatusPollAtByDirectoryRef: React.RefObject<Map<string, number>>
  statusPollBackoffByDirectoryRef: React.RefObject<Map<string, number>>
  lastFullResyncAtByDirectoryRef: React.RefObject<Map<string, number>>
  childDiscoveryDueAtByDirectoryRef: React.RefObject<Map<string, number>>
  staleResyncBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
  childDiscoveryBackoffByDirectoryRef: React.RefObject<DirectoryReadBackoff>
}) {
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
  }, [
    childStores, messageLoader, props.sdk, routingIndex,
    childDiscoveryBackoffByDirectoryRef, lastStatusPollAtByDirectoryRef, staleResyncBackoffByDirectoryRef,
    childDiscoveryDueAtByDirectoryRef, statusPollBackoffByDirectoryRef, lastFullResyncAtByDirectoryRef,
  ])
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
}
