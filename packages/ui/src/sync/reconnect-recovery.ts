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

export function mergeBootstrapSessions(
  rootSessions: Session[],
  allSessions: Session[],
  existingSessions: Session[],
): { sessions: Session[]; rootCount: number } {
  const rootIds = new Set(rootSessions.map((session) => session.id))
  const sessionsById = new Map(existingSessions.map((session) => [session.id, session]))
  for (const session of allSessions) sessionsById.set(session.id, session)
  for (const session of rootSessions) sessionsById.set(session.id, session)

  const includedIds = new Set(rootIds)
  const pendingParentIds: string[] = []
  for (const session of allSessions) {
    const parentId = (session as Session & { parentID?: string | null }).parentID
    if (!parentId) continue
    includedIds.add(session.id)
    pendingParentIds.push(parentId)
  }

  while (pendingParentIds.length > 0) {
    const parentId = pendingParentIds.pop()
    if (!parentId || includedIds.has(parentId)) continue
    const parent = sessionsById.get(parentId)
    if (!parent) continue
    includedIds.add(parentId)
    const ancestorId = (parent as Session & { parentID?: string | null }).parentID
    if (ancestorId) pendingParentIds.push(ancestorId)
  }

  const sessions = [...includedIds]
    .map((id) => sessionsById.get(id))
    .filter((session): session is Session => Boolean(session))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rootCount = sessions.reduce((count, session) => (
    (session as Session & { parentID?: string | null }).parentID ? count : count + 1
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
    const parentId = (session as Session & { parentID?: string | null }).parentID
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
