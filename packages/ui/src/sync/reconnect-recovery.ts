import type { SessionStatus, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { getSessionMaterializationStatus } from "./materialization"

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, Message[]>
  part?: Record<string, Part[]>
}

type ViewedSessionMaterializationTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionMaterializationTarget | null
}

type BootstrapSessionRevisionOptions = {
  baselineRevision: number
  eventRevision?: Record<string, number>
  deletedRevision?: Record<string, number>
}

const getParentId = (session: Session): string | null | undefined => (
  (session as Session & { parentID?: string | null }).parentID
)

const includeAncestorSessions = (
  parentIds: string[],
  includedIds: Set<string>,
  sessionsById: Map<string, Session>,
  excludedIds?: ReadonlySet<string>,
): void => {
  while (parentIds.length > 0) {
    const parentId = parentIds.pop()
    if (!parentId || includedIds.has(parentId) || excludedIds?.has(parentId)) continue
    const parent = sessionsById.get(parentId)
    if (!parent) continue
    includedIds.add(parentId)
    const ancestorId = getParentId(parent)
    if (ancestorId) parentIds.push(ancestorId)
  }
}

export function mergeBootstrapSessions(
  rootSessions: Session[],
  allSessions: Session[] | null,
  existingSessions: Session[],
  revisions?: BootstrapSessionRevisionOptions,
): { sessions: Session[]; rootCount: number } {
  const completeSessions = allSessions ?? existingSessions.filter(
    (session) => Boolean(getParentId(session)),
  )
  const rootIds = new Set(rootSessions.map((session) => session.id))
  const sessionsById = new Map(existingSessions.map((session) => [session.id, session]))
  for (const session of completeSessions) sessionsById.set(session.id, session)
  for (const session of rootSessions) sessionsById.set(session.id, session)

  const includedIds = new Set(rootIds)
  const pendingParentIds: string[] = []
  for (const session of completeSessions) {
    const parentId = getParentId(session)
    if (!parentId) continue
    includedIds.add(session.id)
    pendingParentIds.push(parentId)
  }
  includeAncestorSessions(pendingParentIds, includedIds, sessionsById)

  if (revisions) {
    const deletedIds = new Set(
      Object.entries(revisions.deletedRevision ?? {})
        .filter(([, revision]) => revision > revisions.baselineRevision)
        .map(([sessionId]) => sessionId),
    )
    for (const session of existingSessions) {
      if ((revisions.eventRevision?.[session.id] ?? 0) <= revisions.baselineRevision) continue
      sessionsById.set(session.id, session)
      includedIds.add(session.id)
      const parentId = getParentId(session)
      if (parentId) pendingParentIds.push(parentId)
    }
    for (const sessionId of deletedIds) includedIds.delete(sessionId)
    includeAncestorSessions(pendingParentIds, includedIds, sessionsById, deletedIds)
  }

  const sessions = [...includedIds]
    .map((id) => sessionsById.get(id))
    .filter((session): session is Session => Boolean(session))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rootCount = sessions.reduce((count, session) => (
    getParentId(session) ? count : count + 1
  ), 0)

  return { sessions, rootCount }
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    } else if (!getSessionMaterializationStatus({ message: state.message ?? {}, part: state.part ?? {} }, sessionId).renderable) {
      ids.add(sessionId)
    }
  }

  const parentIds = new Set<string>()
  for (const session of state.session) {
    const parentId = getParentId(session)
    if (parentId) {
      parentIds.add(parentId)
    }
  }
  for (const pid of parentIds) {
    ids.add(pid)
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}
