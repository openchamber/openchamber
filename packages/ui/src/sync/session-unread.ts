// ---------------------------------------------------------------------------
// Unread sessions: a turn that finished and nobody has looked at yet, or a
// session the user marked unread to come back to.
//
// OpenCode owns the turn state. Its session record carries `time.idle`, when
// the last turn ended, and `time.viewed`, a monotone watermark of the last idle
// transition a viewer saw. A session is unread while the turn that ended last
// is newer than the watermark. Because the record lives in OpenCode's database
// the mark survives restarts, and every client of the server sees the same one:
// a view recorded on the phone clears it on the desktop through the
// `session.viewed` event.
//
// The watermark only moves forward, so "mark as unread" cannot lower it. The
// user's mark lives in the session's metadata instead
// (`metadata.openchamber.markedUnread`), which OpenCode also persists and
// broadcasts, so it reaches every client the same way.
// ---------------------------------------------------------------------------

import { useCallback } from "react"
import { z } from "zod"
import { compact, type Metadata, type Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { requestSessionMetadataUpdate } from "./session-archive-batch"

const markSchema = z.object({ openchamber: z.object({ markedUnread: z.object({ at: z.number() }) }) })
const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) })

/**
 * The mark's time per metadata object. `isSessionUnread` runs for every
 * session on each store update, and a record keeps its metadata object until
 * the metadata changes, so each object is parsed once.
 */
const markByMetadata = new WeakMap<Metadata, number | null>()

const markOf = (session: Session): number | null => {
  const metadata = session.metadata
  if (!metadata) return null
  const cached = markByMetadata.get(metadata)
  if (cached !== undefined) return cached
  const at = markSchema.safeParse(metadata).data?.openchamber.markedUnread.at ?? null
  markByMetadata.set(metadata, at)
  return at
}

/** Whether the user marked the session unread. */
const hasUnreadMark = (session: Session): boolean => markOf(session) !== null

/**
 * Only top-level sessions are announced; a subtask reports to its parent. An
 * archived session is put away, whichever path archived it, so it is never
 * unread.
 */
export const canSessionBeUnread = (session: Session | undefined): session is Session => (
  Boolean(session) && !session?.parentID && session?.time.archived === undefined
)

const hasUnseenTurn = (session: Session): boolean => {
  const { idle, viewed } = session.time
  return idle !== undefined && (viewed === undefined || viewed < idle)
}

export const isSessionUnread = (session: Session | undefined): boolean => (
  canSessionBeUnread(session) && (hasUnseenTurn(session) || hasUnreadMark(session))
)

/** Unread because the user marked it, which shows even on the open session. */
export const isSessionMarkedUnread = (session: Session | undefined): boolean => (
  canSessionBeUnread(session) && hasUnreadMark(session)
)

/** Unread, and the turn that left it unread failed. */
export const isSessionUnreadWithError = (session: Session | undefined): boolean => (
  canSessionBeUnread(session) && hasUnseenTurn(session) && session.outcome === "failed"
)

export const useSessionUnread = (sessionId: string): boolean => (
  useGlobalSessionsStore(useCallback((state) => isSessionUnread(state.entityById.get(sessionId)), [sessionId]))
)

export const useSessionMarkedUnread = (sessionId: string): boolean => (
  useGlobalSessionsStore(useCallback((state) => isSessionMarkedUnread(state.entityById.get(sessionId)), [sessionId]))
)

const hasUnreadSession = (state: { entityById: ReadonlyMap<string, Session> }): boolean => {
  for (const session of state.entityById.values()) {
    if (isSessionUnread(session)) return true
  }
  return false
}

/** Whether any session is unread; for a control that only matters while it is shown. */
export const useHasUnreadSession = (): boolean => useGlobalSessionsStore(hasUnreadSession)

/** Idle stamps being recorded right now, so repeated calls send one request. */
const pendingViews = new Map<string, number>()

/**
 * Sessions marked unread in this window that keep the mark until the user
 * opens another session. Marking the open session unread would otherwise
 * clear at once: the open session is marked seen whenever its record changes
 * or the window regains focus.
 */
const keptMarks = new Set<string>()

/** The user moved to another session: marks made in this window clear on the next visit. */
export const releaseKeptUnreadMarks = (): void => {
  keptMarks.clear()
}

const withMarkedUnread = (metadata: Metadata | undefined, at: number | null): Metadata => {
  const current = metadata ?? {}
  const namespace = { ...openchamberSchema.safeParse(current).data?.openchamber }
  if (at === null) delete namespace.markedUnread
  else namespace.markedUnread = { at }
  return { ...current, openchamber: namespace }
}

/** Sets only the mark on the record the store holds now, leaving other metadata as it is. */
const setLocalMark = (sessionId: string, at: number | null): void => {
  const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!current || markOf(current) === at) return
  useGlobalSessionsStore.getState().upsertSession({ ...current, metadata: withMarkedUnread(current.metadata, at) })
}

/** The newest mark write per session; an older one's answer changes nothing. */
const markWrites = new Map<string, number>()
let lastMarkWrite = 0

/**
 * Writes the mark to the session's metadata. The local record changes at once.
 * The answer carries the whole metadata, which can be older than what another
 * feature wrote since, so only the mark is reconciled, and only by the newest
 * write. A failed write restores the previous mark.
 */
const writeUnreadMark = async (session: Session, at: number | null): Promise<boolean> => {
  const runtimeKey = getRuntimeKey()
  const sessionId = session.id
  const previous = markOf(session)
  const write = ++lastMarkWrite
  markWrites.set(sessionId, write)
  setLocalMark(sessionId, at)

  const result = await requestSessionMetadataUpdate(
    sessionId,
    { openchamber: { markedUnread: at === null ? null : { at } } },
    resolveGlobalSessionDirectory(session),
  )
  const newest = markWrites.get(sessionId) === write
  if (newest) markWrites.delete(sessionId)
  if (runtimeKey !== getRuntimeKey()) return false
  if (result.outcome === "updated") {
    if (newest) setLocalMark(sessionId, at)
    return true
  }
  console.warn("[session-unread] failed to save the unread mark", result.reason)
  const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
  // A mark another device wrote meanwhile replaced ours and stays.
  if (newest && current && markOf(current) === at) {
    setLocalMark(sessionId, previous)
    // The restored mark stays until the user opens another session, so the
    // open session's next view does not send the failing write again at once.
    if (at === null) keptMarks.add(sessionId)
  }
  return false
}

/**
 * The user marked the session unread. It stays marked in this window until
 * they open another session and come back to it. Resolves false when the mark
 * could not be saved and was taken back.
 */
export const markSessionUnread = async (sessionId: string): Promise<boolean> => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!canSessionBeUnread(session)) return false
  keptMarks.add(sessionId)
  if (hasUnreadMark(session)) return true
  return writeUnreadMark(session, Date.now())
}

type MarkSeenOptions = {
  /**
   * The user asked for it (Mark as read, Mark all as read), so a mark made in
   * this window clears too. Opening or looking at a session leaves those.
   */
  explicit?: boolean
}

/**
 * Records that the user saw these sessions' last turns. The local records take
 * the watermark at once, in one store update, so the marks clear without
 * waiting for the round trip; a failed write restores its session's mark,
 * unless something newer replaced it. A mark the user set clears with its own
 * metadata write. Returns the sessions it marked.
 */
export const markSessionsUnreadSeen = (sessionIds: Iterable<string>, options: MarkSeenOptions = {}): string[] => {
  const store = useGlobalSessionsStore.getState()
  const runtimeKey = getRuntimeKey()
  const seen: Session[] = []
  const views: { session: Session; idle: number }[] = []
  const marks: Session[] = []
  for (const sessionId of sessionIds) {
    const session = store.entityById.get(sessionId)
    if (!canSessionBeUnread(session)) continue
    if (options.explicit) keptMarks.delete(sessionId)
    const clearsMark = hasUnreadMark(session) && !keptMarks.has(sessionId)
    const idle = session.time.idle
    const recordsView = hasUnseenTurn(session) && idle !== undefined && pendingViews.get(sessionId) !== idle
    if (!clearsMark && !recordsView) continue
    if (clearsMark) marks.push(session)
    if (recordsView) {
      pendingViews.set(sessionId, idle)
      views.push({ session, idle })
      seen.push({ ...session, time: { ...session.time, viewed: idle } })
    }
  }
  if (seen.length > 0) store.upsertSessions(seen)

  for (const { session, idle } of views) {
    const sessionId = session.id
    void opencodeClient.viewSession(sessionId, idle, session.directory)
      .catch((error) => {
        console.warn("[session-unread] failed to record a view", error)
        if (runtimeKey !== getRuntimeKey()) return
        const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
        if (current?.time.viewed !== idle) return
        useGlobalSessionsStore.getState().upsertSession({
          ...current,
          time: compact({ ...current.time, viewed: session.time.viewed }),
        })
      })
      .finally(() => {
        if (pendingViews.get(sessionId) === idle) pendingViews.delete(sessionId)
      })
  }
  for (const marked of marks) {
    const current = useGlobalSessionsStore.getState().entityById.get(marked.id) ?? marked
    void writeUnreadMark(current, null)
  }
  return [...new Set([...views.map(({ session }) => session.id), ...marks.map((session) => session.id)])]
}

export const markSessionUnreadSeen = (sessionId: string, options?: MarkSeenOptions): void => {
  markSessionsUnreadSeen([sessionId], options)
}

/** Every unread session the client knows of. */
export const getUnreadSessionIds = (): string[] => {
  const ids: string[] = []
  for (const session of useGlobalSessionsStore.getState().entityById.values()) {
    if (isSessionUnread(session)) ids.push(session.id)
  }
  return ids
}
