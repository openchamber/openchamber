import type { SessionStatus } from '@opencode-ai/sdk/v2/client'
import type { Session } from '@opencode-ai/sdk/v2'
import type { State } from './types'

type LiveStateSlice = Pick<State, 'session' | 'session_status'>

const getSessionUpdatedAt = (session: Session): number => {
  const updatedAt = session.time?.updated
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return updatedAt
  }

  const createdAt = session.time?.created
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0
}

const getSessionSignature = (session: Session): string => {
  const directory = (session as Session & { directory?: string | null }).directory ?? ''
  const parentID = (session as Session & { parentID?: string | null }).parentID ?? ''
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    directory,
    parentID,
    session.share?.url ?? '',
  ].join('|')
}

const getStatusPriority = (status: SessionStatus | undefined): number => {
  switch (status?.type) {
    case 'retry':
      return 4
    case 'busy':
      return 3
    case 'idle':
      return 1
    default:
      return 0
  }
}

const getStatusMessage = (status: SessionStatus | undefined): string | null => {
  const message = (status as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : null
}

type StatusCandidate = {
  status: SessionStatus
  sessionUpdatedAt: number
}

const getStatusCandidate = (state: LiveStateSlice, sessionId: string): StatusCandidate | null => {
  const status = state.session_status?.[sessionId]
  if (!status) {
    return null
  }

  const session = state.session.find((candidate) => candidate.id === sessionId)
  return {
    status,
    sessionUpdatedAt: session ? getSessionUpdatedAt(session) : -1,
  }
}

const shouldReplaceStatusCandidate = (current: StatusCandidate | undefined, next: StatusCandidate): boolean => {
  if (!current) {
    return true
  }

  if (next.sessionUpdatedAt !== current.sessionUpdatedAt) {
    return next.sessionUpdatedAt > current.sessionUpdatedAt
  }

  return getStatusPriority(next.status) >= getStatusPriority(current.status)
}

export const areSessionListsEquivalent = (left: Session[], right: Session[]): boolean => {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (getSessionSignature(left[index]) !== getSessionSignature(right[index])) {
      return false
    }
  }

  return true
}

export const areStatusMapsEquivalent = (
  left: Record<string, SessionStatus>,
  right: Record<string, SessionStatus>,
): boolean => {
  if (left === right) {
    return true
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  for (const key of leftKeys) {
    if (!(key in right)) {
      return false
    }
    const leftStatus = left[key]
    const rightStatus = right[key]
    if (leftStatus?.type !== rightStatus?.type) {
      return false
    }
    if (getStatusMessage(leftStatus) !== getStatusMessage(rightStatus)) {
      return false
    }
  }

  return true
}

export function aggregateLiveSessions(states: Iterable<LiveStateSlice>): Session[] {
  const sessionsById = new Map<string, Session>()

  for (const state of states) {
    for (const session of state.session) {
      if (!session?.id) {
        continue
      }
      const current = sessionsById.get(session.id)
      if (!current || getSessionUpdatedAt(session) >= getSessionUpdatedAt(current)) {
        sessionsById.set(session.id, session)
      }
    }
  }

  return Array.from(sessionsById.values()).sort((left, right) => {
    return getSessionUpdatedAt(right) - getSessionUpdatedAt(left)
  })
}

export function aggregateLiveSessionStatuses(states: Iterable<LiveStateSlice>): Record<string, SessionStatus> {
  const candidates = new Map<string, StatusCandidate>()

  for (const state of states) {
    for (const sessionId of Object.keys(state.session_status ?? {})) {
      const next = getStatusCandidate(state, sessionId)
      if (!next) {
        continue
      }

      const current = candidates.get(sessionId)
      if (shouldReplaceStatusCandidate(current, next)) {
        candidates.set(sessionId, next)
      }
    }
  }

  const statuses: Record<string, SessionStatus> = {}
  for (const [sessionId, candidate] of candidates) {
    statuses[sessionId] = candidate.status
  }

  return statuses
}

export function findLiveSession(states: Iterable<LiveStateSlice>, sessionID?: string | null): Session | undefined {
  if (!sessionID) {
    return undefined
  }

  let match: Session | undefined
  for (const state of states) {
    const session = state.session.find((candidate) => candidate.id === sessionID)
    if (!session) {
      continue
    }
    if (!match || getSessionUpdatedAt(session) >= getSessionUpdatedAt(match)) {
      match = session
    }
  }

  return match
}

export function findLiveSessionStatus(
  states: Iterable<LiveStateSlice>,
  sessionID?: string | null,
): SessionStatus | undefined {
  if (!sessionID) {
    return undefined
  }

  let match: StatusCandidate | undefined
  for (const state of states) {
    const next = getStatusCandidate(state, sessionID)
    if (!next) {
      continue
    }
    if (shouldReplaceStatusCandidate(match, next)) {
      match = next
    }
  }

  return match?.status
}
