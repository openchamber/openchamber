import type { Session, SessionStatus } from '@/lib/opencode/model'
import type { State } from './types'
import { countSyncPerformance } from './performance-diagnostics'

type LiveStateSlice = Pick<State, 'session' | 'session_status'>

const getSessionUpdatedAt = (session: Session): number => {
  const updatedAt = session.time?.updated
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return updatedAt
  }

  const createdAt = session.time?.created
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0
}

// The fields a live-session consumer renders or orders by. Compared field by
// field rather than through a joined string: this runs over every live
// session each time any directory's session list changes, and an unchanged
// session is usually the same object, which is checked first.
const areSessionsEquivalent = (left: Session, right: Session): boolean => {
  if (left === right) return true
  return left.id === right.id
    && (left.title ?? '') === (right.title ?? '')
    && (left.time?.created ?? 0) === (right.time?.created ?? 0)
    && (left.time?.updated ?? 0) === (right.time?.updated ?? 0)
    && (left.time?.archived ?? 0) === (right.time?.archived ?? 0)
    && (left.directory ?? '') === (right.directory ?? '')
    && (left.parentID ?? '') === (right.parentID ?? '')
    && left.model?.id === right.model?.id
    && left.model?.providerID === right.model?.providerID
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

// Only the retry variant carries attempt/message/next, so equality compares
// those fields when both sides are retries and the discriminator otherwise.
const areStatusesEquivalent = (left: SessionStatus | undefined, right: SessionStatus | undefined): boolean => {
  if (left?.type !== right?.type) return false
  if (left?.type !== 'retry' || right?.type !== 'retry') return true
  return left.attempt === right.attempt && left.message === right.message && left.next === right.next
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
    if (!areSessionsEquivalent(left[index], right[index])) {
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
    if (!areStatusesEquivalent(leftStatus, rightStatus)) {
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
    const sessionUpdatedAtById = new Map<string, number>()
    for (const session of state.session) {
      countSyncPerformance('statusAggregationSessionEntries')
      sessionUpdatedAtById.set(session.id, getSessionUpdatedAt(session))
    }
    for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
      countSyncPerformance('statusAggregationCandidates')
      const next: StatusCandidate = {
        status,
        sessionUpdatedAt: sessionUpdatedAtById.get(sessionId) ?? -1,
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
