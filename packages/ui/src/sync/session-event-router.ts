import { useSyncExternalStore } from "react"
import type { SessionPatch, SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"
import { compact } from "@/lib/opencode/model"
import { withSessionMetadata } from "@/lib/opencode/projection"
import {
  isGlobalSessionDeferrableUpdate,
  mergeSessionDirectoryMetadata,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
  type GlobalSessionMutation,
} from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import { publishGlobalSessionMoves, type GlobalSessionMove } from "./session-moves"
import { noteLiveSessionCosts } from "./session-cost-alerts"
import { readDirectorySession, withDirectorySessions } from "./session-cost-tree"
import { getSyncSessionSlices } from "./sync-refs"
import type { SessionTree } from "@/components/chat/work-status/subagentCost"
import type { GlobalSessionStructure } from "@/stores/globalSessionStructure"

type DeferredGlobalSessionUpdate = {
  runtimeKey: string
  base: Session
  updated: number | undefined
  cost: Session["cost"]
  tokens: Session["tokens"]
}

const sameSpend = (left: Pick<Session, "cost" | "tokens">, right: Pick<Session, "cost" | "tokens">): boolean => (
  left.cost === right.cost && (left.tokens === right.tokens || JSON.stringify(left.tokens ?? null) === JSON.stringify(right.tokens ?? null))
)

export const withDeferredGlobalUpdate = (current: Session, deferred: DeferredGlobalSessionUpdate | undefined): Session => {
  if (!deferred) return current
  const spendStillOurs = current === deferred.base || sameSpend(current, deferred.base)
  const applySpend = spendStillOurs && !sameSpend(current, deferred)
  const updated = deferred.updated !== undefined && deferred.updated > (current.time?.updated ?? 0) ? deferred.updated : null
  if (!applySpend && updated === null) return current
  const next: Session = { ...current }
  if (applySpend) {
    next.cost = deferred.cost
    next.tokens = deferred.tokens
  }
  if (updated !== null) next.time = { ...current.time, updated }
  return next
}

export const readGlobalSessionTree = (
  state: { entityById: ReadonlyMap<string, Session>; structure: GlobalSessionStructure },
  deferred: ReadonlyMap<string, DeferredGlobalSessionUpdate>,
): SessionTree => ({
  readSession: (sessionId) => {
    const session = state.entityById.get(sessionId)
    return session && withDeferredGlobalUpdate(session, deferred.get(sessionId))
  },
  childIdsOf: (sessionId) => state.structure.activeChildrenByParentId.get(sessionId),
})

export const readSessionCostTree = (
  state: { entityById: ReadonlyMap<string, Session>; structure: GlobalSessionStructure },
  deferred: ReadonlyMap<string, DeferredGlobalSessionUpdate>,
  slices: Iterable<readonly [string, readonly Session[]]>,
  directoryCost?: ReadonlyMap<string, number>,
): SessionTree => withDirectorySessions(
  readGlobalSessionTree(state, deferred),
  (sessionId) => state.entityById.has(sessionId),
  slices,
  directoryCost,
)

const pendingGlobalSessionUpdates = new Map<string, DeferredGlobalSessionUpdate>()

const deferredListeners = new Set<() => void>()
let deferredSnapshot: ReadonlyMap<string, DeferredGlobalSessionUpdate> | null = new Map()

const noteDeferredChange = (): void => {
  deferredSnapshot = null
  for (const listener of deferredListeners) listener()
}

export const readDeferredGlobalUpdates = (): ReadonlyMap<string, DeferredGlobalSessionUpdate> => {
  if (deferredSnapshot) return deferredSnapshot
  const runtimeKey = getRuntimeKey()
  const next = new Map<string, DeferredGlobalSessionUpdate>()
  for (const [sessionId, update] of pendingGlobalSessionUpdates) {
    if (update.runtimeKey === runtimeKey) next.set(sessionId, update)
  }
  deferredSnapshot = next
  return next
}

export const subscribeDeferredGlobalUpdates = (listener: () => void): (() => void) => {
  deferredListeners.add(listener)
  return () => { deferredListeners.delete(listener) }
}

export const useDeferredGlobalUpdates = (): ReadonlyMap<string, DeferredGlobalSessionUpdate> => (
  useSyncExternalStore(subscribeDeferredGlobalUpdates, readDeferredGlobalUpdates, readDeferredGlobalUpdates)
)

const dropPendingGlobalSessionUpdate = (sessionId: string): void => {
  if (pendingGlobalSessionUpdates.delete(sessionId)) noteDeferredChange()
}

const clearPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdates.clear()
  noteDeferredChange()
}

const scheduleGlobalSessionUpdate = (base: Session, session: Session): void => {
  pendingGlobalSessionUpdates.set(session.id, {
    runtimeKey: getRuntimeKey(),
    base,
    updated: session.time?.updated,
    cost: session.cost,
    tokens: session.tokens,
  })
  noteDeferredChange()
  streamPerfCount("ui.global_sessions.event_update_deferred")
}

subscribeRuntimeEndpointWillChange(clearPendingGlobalSessionUpdates)

const applyPatch = (session: Session, patch: SessionPatch): Session => {
  const next: Session = patch.metadata === undefined ? { ...session } : withSessionMetadata(session, patch.metadata)
  if (patch.title !== undefined) next.title = patch.title
  if (patch.directory !== undefined) next.directory = patch.directory
  if (patch.projectID !== undefined) next.projectID = patch.projectID
  if (patch.agent !== undefined) next.agent = patch.agent
  if (patch.model !== undefined) next.model = patch.model
  if (patch.cost !== undefined) next.cost = patch.cost
  if (patch.tokens !== undefined) next.tokens = patch.tokens
  if (patch.permissions !== undefined) next.permissions = patch.permissions
  if (patch.outcome !== undefined) next.outcome = patch.outcome
  if (patch.subpath === null) delete next.subpath
  else if (patch.subpath !== undefined) next.subpath = patch.subpath
  if (patch.revert === null) delete next.revert
  else if (patch.revert !== undefined) next.revert = patch.revert
  if (patch.time) {
    const { archived, ...rest } = patch.time
    next.time = compact({ ...session.time, ...rest, archived: archived ?? session.time.archived })
  }
  return next
}

export const applySessionEventsToGlobalSessions = (payloads: readonly SyncEvent[]): void => {
  if (payloads.length === 0) return
  const runtimeKey = getRuntimeKey()
  const store = useGlobalSessionsStore.getState()
  const changed = new Map<string, Session | null>()
  const read = (sessionId: string): Session | undefined => (
    changed.has(sessionId) ? changed.get(sessionId) ?? undefined : store.entityById.get(sessionId)
  )
  const mutations: GlobalSessionMutation[] = []
  const moves: GlobalSessionMove[] = []
  const costBefore = new Map<string, number>()
  const directoryCost = new Map<string, number>()
  let directorySlices: ReturnType<typeof getSyncSessionSlices> | undefined
  let flushedRecency = false

  const appendUpsert = (session: Session): void => {
    const existing = read(session.id) ?? null
    const merged = mergeSessionDirectoryMetadata(session, existing)
    changed.set(session.id, merged)
    mutations.push({ type: "upsert", session: merged })
  }

  for (const payload of payloads) {
    if (payload.type === "session.idle" || payload.type === "session.error") {
      const { sessionID } = payload.properties
      const update = pendingGlobalSessionUpdates.get(sessionID)
      dropPendingGlobalSessionUpdate(sessionID)
      if (!update || update.runtimeKey !== runtimeKey) continue
      const currentSession = read(sessionID) ?? null
      if (!currentSession) continue
      const session = withDeferredGlobalUpdate(currentSession, update)
      if (
        session === currentSession
        || shouldSkipStaleSessionEvent(currentSession, session)
        || !isGlobalSessionDeferrableUpdate(currentSession, session)
      ) continue
      appendUpsert(session)
      flushedRecency = true
      continue
    }

    if (payload.type === "session.created") {
      const session = stripSessionDiffSnapshots(payload.properties.info)
      const currentSession = read(session.id) ?? null
      if (!shouldSkipStaleSessionEvent(currentSession, session)) appendUpsert(session)
      continue
    }

    if (payload.type === "session.patched") {
      const { sessionID, patch } = payload.properties
      const currentSession = read(sessionID) ?? null
      if (!currentSession) {
        if (patch.cost === undefined) continue
        const directorySession = readDirectorySession(sessionID, directorySlices ??= getSyncSessionSlices())
        if (!directorySession) continue
        if (!costBefore.has(sessionID)) costBefore.set(sessionID, directoryCost.get(sessionID) ?? directorySession.cost)
        directoryCost.set(sessionID, patch.cost)
        continue
      }
      const pending = pendingGlobalSessionUpdates.get(sessionID)
      const base = withDeferredGlobalUpdate(currentSession, pending?.runtimeKey === runtimeKey ? pending : undefined)
      const session = stripSessionDiffSnapshots(applyPatch(base, patch))
      if (shouldSkipStaleSessionEvent(currentSession, session)) continue
      if (patch.cost !== undefined && !costBefore.has(sessionID)) costBefore.set(sessionID, base.cost)
      const from = patch.directory === undefined ? null : resolveGlobalSessionDirectory(currentSession)
      const to = patch.directory === undefined ? null : resolveGlobalSessionDirectory(session)
      if (from && to && from !== to) moves.push({ sessionId: sessionID, from, to })
      if (isGlobalSessionDeferrableUpdate(currentSession, session)) {
        scheduleGlobalSessionUpdate(currentSession, session)
        store.noteDeferredSessionUpdate(sessionID)
      } else {
        dropPendingGlobalSessionUpdate(sessionID)
        appendUpsert(session)
        streamPerfCount("ui.global_sessions.event_update_immediate")
      }
      continue
    }

    if (payload.type === "session.deleted") {
      const { sessionID } = payload.properties
      dropPendingGlobalSessionUpdate(sessionID)
      changed.set(sessionID, null)
      mutations.push({ type: "remove", sessionId: sessionID })
    }
  }

  if (runtimeKey !== getRuntimeKey()) return
  if (mutations.length > 0) {
    if (flushedRecency) streamPerfMark("global_sessions.event_update_flush")
    store.applySessionMutations(mutations)
    streamPerfCount("ui.global_sessions.event_update_publication")
    publishGlobalSessionMoves(moves)
  }
  if (costBefore.size === 0) return
  noteLiveSessionCosts(costBefore, readSessionCostTree(
    useGlobalSessionsStore.getState(),
    readDeferredGlobalUpdates(),
    directorySlices ?? getSyncSessionSlices(),
    directoryCost,
  ))
}

export const applySessionEventToGlobalSessions = (payload: SyncEvent): void => {
  applySessionEventsToGlobalSessions([payload])
}
