import { describe, expect, it } from 'bun:test'

import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  findLiveSession,
  findLiveSessionStatus,
} from '../live-aggregate.ts'
import { deriveLiveActiveNowSessions } from '../../components/session/sidebar/activitySections.ts'

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

  it('derives active-now sessions from live statuses instead of persisted history', () => {
    const sessions = [
      session('ses-1', '/a', 20),
      session('ses-2', '/b', 30),
      session('ses-3', '/c', 10, { time: { created: 9, updated: 10, archived: 50 } }),
      session('ses-4', '/d', 40, { parentID: 'ses-parent' }),
    ]

    const activeNow = deriveLiveActiveNowSessions(sessions, {
      'ses-1': { type: 'busy' },
      'ses-2': { type: 'retry', message: 'retrying' },
      'ses-3': { type: 'busy' },
      'ses-4': { type: 'busy' },
    })

    expect(activeNow.map((item) => item.id)).toEqual(['ses-2', 'ses-1'])
  })
})
