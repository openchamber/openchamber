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

/**
 * What a running turn changed in a session's global record and has not
 * published yet: the fields themselves, never a whole record, so a record
 * another owner publishes meanwhile (a view, a metadata write, a refresh)
 * keeps its own changes. `base` is the published record the spend was read
 * against: when the published spend differs from it, someone else wrote spend
 * since (a refresh), and the deferred spend is older than that.
 */
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

/** `current` with a deferred update laid over it; `current` itself when nothing of it still applies. */
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

const pendingGlobalSessionUpdates = new Map<string, DeferredGlobalSessionUpdate>()

// The deferred updates, for the few readouts that show what a turn changes at
// each step in a session no directory store holds (a run lane's cost).
// Rebuilt on read after a change, so a step costs one small map at most.
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

const subscribeDeferredGlobalUpdates = (listener: () => void): (() => void) => {
  deferredListeners.add(listener)
  return () => { deferredListeners.delete(listener) }
}

/**
 * The updates still waiting for their turn's end (spend and `time.updated`),
 * keyed by session id. Lay them over the global list with
 * `withDeferredGlobalUpdate` where a readout shows spend while a turn runs.
 */
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

/**
 * Applies a session patch to the global list's own record.
 *
 * The global list holds whole sessions (the sidebar renders them), while the
 * event stream only reports what changed. The record already in the store is
 * the authoritative base to patch — an event carrying a partial session would
 * otherwise erase the fields it does not mention.
 */
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
  // What this batch changed so far, `null` for a removal; every other read
  // falls through to the store. A copy of the whole map per batch cost more
  // than the rest of the batch with thousands of sessions.
  const changed = new Map<string, Session | null>()
  const read = (sessionId: string): Session | undefined => (
    changed.has(sessionId) ? changed.get(sessionId) ?? undefined : store.entityById.get(sessionId)
  )
  const mutations: GlobalSessionMutation[] = []
  const moves: GlobalSessionMove[] = []
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
      // Laid over the record as it is now, which may have changed since.
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
      // Nothing to patch: the global list has never seen this session, and a
      // partial patch cannot stand in for the record it is missing.
      if (!currentSession) continue
      // A deferred update holds what earlier patches of this turn carried: the
      // next patch builds on the published record with it laid over, so it
      // keeps both those and whatever another owner published since.
      const pending = pendingGlobalSessionUpdates.get(sessionID)
      const base = withDeferredGlobalUpdate(currentSession, pending?.runtimeKey === runtimeKey ? pending : undefined)
      const session = stripSessionDiffSnapshots(applyPatch(base, patch))
      if (shouldSkipStaleSessionEvent(currentSession, session)) continue
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

  if (mutations.length === 0 || runtimeKey !== getRuntimeKey()) return
  if (flushedRecency) streamPerfMark("global_sessions.event_update_flush")
  store.applySessionMutations(mutations)
  streamPerfCount("ui.global_sessions.event_update_publication")
  publishGlobalSessionMoves(moves)
}

export const applySessionEventToGlobalSessions = (payload: SyncEvent): void => {
  applySessionEventsToGlobalSessions([payload])
}
