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
    && left.cost === right.cost
    && left.tokens?.input === right.tokens?.input
    && left.tokens?.output === right.tokens?.output
    && left.tokens?.reasoning === right.tokens?.reasoning
    && left.tokens?.cache?.read === right.tokens?.cache?.read
    && left.tokens?.cache?.write === right.tokens?.cache?.write
    && left.metadata === right.metadata
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

type SessionSources = ReadonlyArray<LiveStateSlice["session"]>

type LiveAggregate = {
  sources: SessionSources
  result: Session[]
  winners: Map<string, Session>
  rank: Map<string, number>
  duplicates: Set<string>
}

let lastAggregate: LiveAggregate = {
  sources: [],
  result: [],
  winners: new Map(),
  rank: new Map(),
  duplicates: new Set(),
}

const MAX_INCREMENTAL_CHANGES = 64

export function aggregateLiveSessions(states: Iterable<LiveStateSlice>): Session[] {
  const sources = Array.from(states, (state) => state.session)
  const previous = lastAggregate
  if (sources.length === previous.sources.length && sources.every((source, index) => source === previous.sources[index])) {
    return previous.result
  }
  lastAggregate = updateAggregate(previous, sources) ?? buildAggregate(sources)
  return lastAggregate.result
}

function buildAggregate(sources: SessionSources): LiveAggregate {
  const winners = new Map<string, Session>()
  const duplicates = new Set<string>()

  for (const list of sources) {
    for (const session of list) {
      if (!session?.id) {
        continue
      }
      const current = winners.get(session.id)
      if (current) duplicates.add(session.id)
      if (!current || getSessionUpdatedAt(session) >= getSessionUpdatedAt(current)) {
        winners.set(session.id, session)
      }
    }
  }

  const rank = new Map<string, number>()
  for (const id of winners.keys()) rank.set(id, rank.size)
  const result = Array.from(winners.values()).sort((left, right) => {
    return getSessionUpdatedAt(right) - getSessionUpdatedAt(left)
  })
  return { sources, result, winners, rank, duplicates }
}

function updateAggregate(previous: LiveAggregate, sources: SessionSources): LiveAggregate | null {
  if (sources.length !== previous.sources.length) return null
  const replaced = new Map<string, Session>()
  for (let index = 0; index < sources.length; index += 1) {
    const before = previous.sources[index]
    const after = sources[index]
    if (before === after) continue
    if (before.length !== after.length) return null
    for (let position = 0; position < after.length; position += 1) {
      const old = before[position]
      const next = after[position]
      if (old === next) continue
      if (old?.id !== next?.id) return null
      if (!next?.id) continue
      replaced.set(next.id, next)
      if (replaced.size > MAX_INCREMENTAL_CHANGES) return null
    }
  }

  const { winners, rank, duplicates } = previous
  const compare = (left: Session, right: Session): number => (
    getSessionUpdatedAt(right) - getSessionUpdatedAt(left)
    || (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0)
  )
  let result = previous.result
  for (const [id, record] of replaced) {
    const next = duplicates.has(id) ? findFreshestRecord(sources, id) : record
    const current = winners.get(id)
    if (!next || !current || next === current) continue
    if (result === previous.result) result = result.slice()
    const from = lowerBound(result, current, compare)
    if (result[from] !== current) return null
    result.splice(from, 1)
    result.splice(lowerBound(result, next, compare), 0, next)
    winners.set(id, next)
  }
  return { sources, result, winners, rank, duplicates }
}

function findFreshestRecord(sources: SessionSources, id: string): Session | undefined {
  let match: Session | undefined
  for (const list of sources) {
    for (const session of list) {
      if (session?.id !== id) continue
      if (!match || getSessionUpdatedAt(session) >= getSessionUpdatedAt(match)) match = session
    }
  }
  return match
}

function lowerBound(sessions: readonly Session[], target: Session, compare: (left: Session, right: Session) => number): number {
  let low = 0
  let high = sessions.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compare(sessions[middle], target) < 0) low = middle + 1
    else high = middle
  }
  return low
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
