import type { StoreApi } from "zustand"
import { type SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { retry } from "./retry"
import { hasPromptInFlight } from "./prompts-in-flight"
import { stripSessionDiffSnapshots } from "./sanitize"
import { upsertSessionRecord } from "./session-records"
import { syncDebug } from "./debug"
import { opencodeClient } from "@/lib/opencode/client"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { reconcileGlobalSessionStatusWithActive } from "./global-session-status"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { type EventRoutingIndex, setIndexedSessionDirectory, setIndexedSessionMessages, ingestDirectoryStateIntoRoutingIndex } from "./event-routing-index"
import { getActiveSessionCandidateIds, resyncDirectorySessionStatuses } from "./session-status-recovery"
import { markRecordedInterruptedTurn } from "./interrupted-turn-recovery"
import { resyncBlockingRequestsForDirectory } from "./blocking-request-recovery"
import { isCatalogRuntimeCurrent } from "./sync-catalog-refresh"

const RECONNECT_MESSAGE_LIMIT = 30

export async function resyncDirectoryAfterReconnect(
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

type CatalogRuntime = Parameters<typeof isCatalogRuntimeCurrent>[0]

/**
 * The sessions OpenCode's running list says are running, or null when the
 * list cannot settle anything: a read failed, the runtime changed meanwhile,
 * or a replaced OpenCode is still draining (it runs the turns busy at its
 * handoff, which this list does not name). The host's list never covers a
 * session inside an isolated space.
 */
async function settlingActiveSessionIds(
  activeRead: ReturnType<typeof opencodeClient.getActiveSessionStatuses>,
  runtime: CatalogRuntime,
): Promise<ReadonlySet<string> | null> {
  const active = await activeRead
  if (!active || !isCatalogRuntimeCurrent(runtime)) return null
  // Read the handoff state after the active list: a drain may have started
  // while OpenCode was answering, and that makes its missing entries inconclusive.
  const host = await opencodeClient.getHostSessionStatusSnapshot()
  if (!host || host.openCodeDraining === true || !isCatalogRuntimeCurrent(runtime)) return null
  return new Set(Object.keys(active))
}

const currentCatalogRuntime = (): CatalogRuntime => ({ key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() })

export const readSettlingActiveSessionIds = (): Promise<ReadonlySet<string> | null> => {
  const runtime = currentCatalogRuntime()
  return settlingActiveSessionIds(opencodeClient.getActiveSessionStatuses(), runtime)
}

/** Sessions the host's active list speaks for (see `reconcileGlobalSessionStatusWithActive`). */
export const isCoveredByHostActiveList = (sessionId: string, directory: string): boolean => (
  !isSpaceDirectory(directory) && !hasPromptInFlight(sessionId)
)

/**
 * A deferred store that looked idle before a stream gap may own a session
 * that started a turn, or asked a permission or form, during it. OpenCode's
 * active-session list is global, so one read finds those stores without
 * reading any directory, and settles the cross-directory status of sessions
 * whose end fell into the gap. A failed read leaves both as before.
 */
export async function reconcileActivityAfterGap(childStores: ChildStoreManager): Promise<void> {
  const runtime = currentCatalogRuntime()
  const activeRead = opencodeClient.getActiveSessionStatuses()
  await reconcileGlobalSessionStatusWithActive(
    () => settlingActiveSessionIds(activeRead, runtime),
    isCoveredByHostActiveList,
  )
  const active = await activeRead
  if (!active || !isCatalogRuntimeCurrent(runtime)) return
  childStores.refreshStaleDirectoriesWithActiveSessions(new Set(Object.keys(active)))
}
