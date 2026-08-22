import { beforeEach, describe, expect, it } from 'bun:test'

import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
  mergeDerivedSessionStatuses,
} from '../live-aggregate.ts'
import {
  applyGlobalSessionStatusEvent,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from '../global-session-status.ts'
import { deriveRecentSessions } from '../../components/session/sidebar/activitySections.ts'

// Mirrors the production 48h window in activitySections.ts (the constant is
// not exported).
const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000

const session = (id, directory, updated, extra = {}) => ({
  id,
  title: `${id}-title`,
  time: { created: updated - 1, updated, archived: undefined },
  directory,
  ...extra,
})

describe('live aggregate', () => {
  it('prefers the freshest live session snapshot across child stores', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10, { title: 'old' })],
        session_status: {},
      },
      {
        session: [session('ses-1', '/a', 25, { title: 'new' }), session('ses-2', '/b', 20)],
        session_status: {},
      },
    ]

    const sessions = aggregateLiveSessions(states)
    expect(sessions.map((item) => `${item.id}:${item.title}`)).toEqual(['ses-1:new', 'ses-2:ses-2-title'])
    expect(findLiveSession(states, 'ses-1')?.title).toBe('new')
  })

  it('prefers busy/retry statuses over stale idle snapshots', () => {
    const states = [
      {
        session: [],
        session_status: {
          'ses-1': { type: 'idle' },
          'ses-2': { type: 'idle' },
        },
      },
      {
        session: [],
        session_status: {
          'ses-1': { type: 'busy' },
          'ses-2': { type: 'retry', message: 'retrying' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('busy')
    expect(statuses['ses-2']?.type).toBe('retry')
    expect(findLiveSessionStatus(states, 'ses-2')?.type).toBe('retry')
  })

  it('lets a fresher idle snapshot override a stale busy status', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10)],
        session_status: {
          'ses-1': { type: 'busy' },
        },
      },
      {
        session: [session('ses-1', '/a', 30)],
        session_status: {
          'ses-1': { type: 'idle' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('idle')
    expect(findLiveSessionStatus(states, 'ses-1')?.type).toBe('idle')
  })

  it('detects retry metadata changes in status maps', () => {
    const retryStatus = { type: 'retry', message: 'retrying|server|message', attempt: 1, next: 100 }

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus } },
    )).toBe(true)

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus, attempt: 2, next: 200 } },
    )).toBe(false)
  })

  it('derives recent sessions from the 48h window, excluding archived/subtasks', () => {
    const now = 1_000_000_000
    const sessions = [
      session('ses-1', '/a', now - 1_000),
      session('ses-2', '/b', now - 500),
      session('ses-3', '/c', now - 10, { time: { created: now - 11, updated: now - 10, archived: now - 5 } }),
      session('ses-4', '/d', now - 200, { parentID: 'ses-parent' }),
      session('ses-5', '/e', now - RECENT_SESSION_MAX_AGE_MS - 1),
    ]

    // deriveRecentSessions is a membership filter; the caller applies lifecycle
    // ordering, so output keeps the input order.
    const recent = deriveRecentSessions(sessions, new Set(), now)

    // ses-3 archived, ses-4 subtask, ses-5 older than 48h -> excluded
    expect(recent.map((item) => item.id)).toEqual(['ses-1', 'ses-2'])
  })
})

describe('mergeDerivedSessionStatuses', () => {
  it('shows a parent active when a background child is busy and the parent raw status is idle', () => {
    const raw = aggregateLiveSessionStatuses([
      {
        session: [session('parent-1', '/a', 10)],
        session_status: {
          'parent-1': { type: 'idle' },
          'child-1': { type: 'busy' },
        },
      },
    ])

    // The global status index contributes the derived parent busy entry.
    const merged = mergeDerivedSessionStatuses(raw, { 'parent-1': { type: 'busy' } })

    // Agent Manager / group busy predicate: `allStatuses[id]?.type === 'busy'`.
    expect(merged['parent-1']?.type).toBe('busy')
    expect(merged['child-1']?.type).toBe('busy')
  })

  it('keeps raw busy/retry statuses authoritative over a derived entry', () => {
    const raw = aggregateLiveSessionStatuses([
      {
        session: [],
        session_status: {
          'parent-1': { type: 'retry', attempt: 2, message: 'waiting', next: 5 },
        },
      },
    ])

    const merged = mergeDerivedSessionStatuses(raw, { 'parent-1': { type: 'busy' } })
    expect(merged['parent-1']).toEqual({ type: 'retry', attempt: 2, message: 'waiting', next: 5 })
  })

  it('returns the raw map unchanged when no derived entry exists (child settled)', () => {
    const raw = { 'parent-1': { type: 'idle' } }
    expect(mergeDerivedSessionStatuses(raw, {})).toBe(raw)
  })

  it('fills a gap for a session absent from the raw map', () => {
    const merged = mergeDerivedSessionStatuses({}, { 'parent-1': { type: 'busy' } })
    expect(merged).toEqual({ 'parent-1': { type: 'busy' } })
  })
})

describe('Agent Manager group busy observable (derived parent activity)', () => {
  beforeEach(() => {
    resetGlobalSessionStatus()
  })

  const collectDerivedEntries = () => {
    const entries = {}
    for (const [sessionId, entry] of useGlobalSessionStatusStore.getState().statusById) {
      if (entry.derived === true) entries[sessionId] = entry.status
    }
    return entries
  }

  // The exact chain `useAllSessionStatuses` wires together: raw directory
  // aggregation + derived-only global entries merged for the group indicator.
  const observableStatuses = (rawStates, derived) => mergeDerivedSessionStatuses(aggregateLiveSessionStatuses(rawStates), derived)

  it('busy child + idle parent -> parent/group active; child settles -> indicator clears', () => {
    // Learn the parent-child relation and run the background child busy.
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.updated',
      properties: { info: { id: 'child-1', parentID: 'parent-1' } },
    })
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.status',
      properties: { sessionID: 'child-1', status: { type: 'busy' } },
    })

    // The parent's raw directory status is idle, exactly the gap the derived
    // entry fills.
    const rawStates = [
      {
        session: [session('parent-1', '/a', 10), session('child-1', '/a', 10)],
        session_status: { 'parent-1': { type: 'idle' } },
      },
    ]
    const statuses = observableStatuses(rawStates, collectDerivedEntries())
    expect(statuses['parent-1']?.type).toBe('busy')

    // The group indicator predicate used by AgentManagerSidebar/AgentGroupDetail.
    expect(['parent-1'].some((id) => statuses[id]?.type === 'busy')).toBe(true)

    // The background child settles: the derived entry disappears from the
    // global index, so the observable clears with it.
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.idle',
      properties: { sessionID: 'child-1' },
    })
    const statusesAfterSettle = observableStatuses(rawStates, collectDerivedEntries())
    expect(statusesAfterSettle['parent-1']?.type ?? 'idle').toBe('idle')
    expect(['parent-1'].some((id) => statusesAfterSettle[id]?.type === 'busy')).toBe(false)
  })

  it('runtime reset clears derived entries so no stale group indicator survives', () => {
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.updated',
      properties: { info: { id: 'child-1', parentID: 'parent-1' } },
    })
    applyGlobalSessionStatusEvent('/repo', {
      type: 'session.status',
      properties: { sessionID: 'child-1', status: { type: 'busy' } },
    })
    expect(collectDerivedEntries()['parent-1']?.type).toBe('busy')

    resetGlobalSessionStatus()
    expect(collectDerivedEntries()).toEqual({})
  })
})
