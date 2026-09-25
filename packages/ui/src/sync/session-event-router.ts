import type { SessionPatch, SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"
import { compact } from "@/lib/opencode/model"
import {
  isGlobalSessionRecencyOnlyUpdate,
  mergeSessionDirectoryMetadata,
  useGlobalSessionsStore,
  type GlobalSessionMutation,
} from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

const pendingGlobalSessionUpdates = new Map<string, { runtimeKey: string; session: Session }>()

const clearPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdates.clear()
}

const scheduleGlobalSessionUpdate = (session: Session): void => {
  pendingGlobalSessionUpdates.set(session.id, { runtimeKey: getRuntimeKey(), session })
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
  const next: Session = { ...session }
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
  const overlay = new Map(store.entityById)
  const mutations: GlobalSessionMutation[] = []
  let flushedRecency = false

  const appendUpsert = (session: Session): void => {
    const existing = overlay.get(session.id) ?? null
    const merged = mergeSessionDirectoryMetadata(session, existing)
    overlay.set(session.id, merged)
    mutations.push({ type: "upsert", session: merged })
  }

  for (const payload of payloads) {
    if (payload.type === "session.idle" || payload.type === "session.error") {
      const { sessionID } = payload.properties
      const update = pendingGlobalSessionUpdates.get(sessionID)
      pendingGlobalSessionUpdates.delete(sessionID)
      if (!update || update.runtimeKey !== runtimeKey) continue
      const currentSession = overlay.get(sessionID) ?? null
      if (
        !currentSession
        || shouldSkipStaleSessionEvent(currentSession, update.session)
        || !isGlobalSessionRecencyOnlyUpdate(currentSession, update.session)
      ) continue
      appendUpsert(update.session)
      flushedRecency = true
      continue
    }

    if (payload.type === "session.created") {
      const session = stripSessionDiffSnapshots(payload.properties.info)
      const currentSession = overlay.get(session.id) ?? null
      if (!shouldSkipStaleSessionEvent(currentSession, session)) appendUpsert(session)
      continue
    }

    if (payload.type === "session.patched") {
      const { sessionID, patch } = payload.properties
      const currentSession = overlay.get(sessionID) ?? null
      // Nothing to patch: the global list has never seen this session, and a
      // partial patch cannot stand in for the record it is missing.
      if (!currentSession) continue
      const session = stripSessionDiffSnapshots(applyPatch(currentSession, patch))
      if (shouldSkipStaleSessionEvent(currentSession, session)) continue
      if (isGlobalSessionRecencyOnlyUpdate(currentSession, session)) {
        scheduleGlobalSessionUpdate(session)
      } else {
        pendingGlobalSessionUpdates.delete(sessionID)
        appendUpsert(session)
        streamPerfCount("ui.global_sessions.event_update_immediate")
      }
      continue
    }

    if (payload.type === "session.deleted") {
      const { sessionID } = payload.properties
      pendingGlobalSessionUpdates.delete(sessionID)
      overlay.delete(sessionID)
      mutations.push({ type: "remove", sessionId: sessionID })
    }
  }

  if (mutations.length === 0 || runtimeKey !== getRuntimeKey()) return
  if (flushedRecency) streamPerfMark("global_sessions.event_update_flush")
  store.applySessionMutations(mutations)
  streamPerfCount("ui.global_sessions.event_update_publication")
}

export const applySessionEventToGlobalSessions = (payload: SyncEvent): void => {
  applySessionEventsToGlobalSessions([payload])
}
