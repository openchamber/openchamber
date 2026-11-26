
import { useCallback } from "react"
import { z } from "zod"
import { compact, type Metadata, type Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { requestSessionMetadataUpdate } from "./session-archive-batch"

const markSchema = z.object({ openchamber: z.object({ markedUnread: z.object({ at: z.number() }) }) })
const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) })

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

const hasUnreadMark = (session: Session): boolean => markOf(session) !== null

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

export const isSessionMarkedUnread = (session: Session | undefined): boolean => (
  canSessionBeUnread(session) && hasUnreadMark(session)
)

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

export const useHasUnreadSession = (): boolean => useGlobalSessionsStore(hasUnreadSession)

const pendingViews = new Map<string, number>()

const keptMarks = new Set<string>()

const visitBaselines = new Map<string, number | undefined>()

export const readVisitBaseline = (sessionId: string): number | undefined => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!canSessionBeUnread(session)) return undefined
  return (visitBaselines.has(sessionId) ? visitBaselines.get(sessionId) : session.time.viewed) ?? 0
}

export const endSessionVisit = (sessionId: string): void => {
  visitBaselines.delete(sessionId)
}

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

const setLocalMark = (sessionId: string, at: number | null): void => {
  const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!current || markOf(current) === at) return
  useGlobalSessionsStore.getState().upsertSession({ ...current, metadata: withMarkedUnread(current.metadata, at) })
}

const markWrites = new Map<string, number>()
let lastMarkWrite = 0

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
  if (newest && current && markOf(current) === at) {
    setLocalMark(sessionId, previous)
    if (at === null) keptMarks.add(sessionId)
  }
  return false
}

export const markSessionUnread = async (sessionId: string): Promise<boolean> => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!canSessionBeUnread(session)) return false
  keptMarks.add(sessionId)
  if (hasUnreadMark(session)) return true
  return writeUnreadMark(session, Date.now())
}

type MarkSeenOptions = {
  explicit?: boolean
}

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
      if (!visitBaselines.has(sessionId)) visitBaselines.set(sessionId, session.time.viewed)
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

export const getUnreadSessionIds = (): string[] => {
  const ids: string[] = []
  for (const session of useGlobalSessionsStore.getState().entityById.values()) {
    if (isSessionUnread(session)) ids.push(session.id)
  }
  return ids
}
