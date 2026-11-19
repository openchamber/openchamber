import { describe, expect, test } from 'bun:test'
import type { Session } from '@/lib/opencode/model'

import { aggregateLiveSessions } from '../live-aggregate'

// The order the aggregate promises: the freshest record per id (a later list
// wins a tie), newest first, ties in the order ids first appear.
const reference = (lists: Session[][]): Session[] => {
  const byId = new Map<string, Session>()
  for (const list of lists) {
    for (const session of list) {
      const current = byId.get(session.id)
      if (!current || (session.time.updated ?? 0) >= (current.time.updated ?? 0)) byId.set(session.id, session)
    }
  }
  return [...byId.values()].sort((left, right) => (right.time.updated ?? 0) - (left.time.updated ?? 0))
}

const record = (id: string, updated: number, step: number): Session => ({
  id,
  projectID: 'prj_1',
  title: `${id}@${step}`,
  directory: '/d',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated },
})

// A deterministic generator, so a failure reproduces.
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

describe('aggregateLiveSessions', () => {
  test('matches a full rebuild through streamed in-place updates, ties and duplicate ids', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed)
      const ids = Array.from({ length: 30 }, (_, index) => `ses_${String(index).padStart(2, '0')}`)
      // Three directories; some ids live in two of them, as a moved session does.
      let lists = [0, 1, 2].map((list) => ids
        .filter((_, index) => index % 3 === list || (index % 7 === 0 && list === 2))
        .map((id) => record(id, Math.floor(next() * 5), 0)))
      expect(aggregateLiveSessions(lists.map((session) => ({ session, session_status: {} })))).toEqual(reference(lists))

      for (let step = 1; step <= 60; step += 1) {
        const list = Math.floor(next() * lists.length)
        const position = Math.floor(next() * lists[list].length)
        const roll = next()
        const updated = lists[list].slice()
        if (roll < 0.05 && updated.length > 1) {
          updated.splice(position, 1)
        } else {
          const old = updated[position]
          const time = roll < 0.3 ? old.time.updated ?? 0 : roll < 0.4 ? Math.floor(next() * 5) : (old.time.updated ?? 0) + Math.floor(next() * 3)
          updated[position] = record(old.id, time, step)
        }
        lists = lists.map((current, index) => (index === list ? updated : current))
        const result = aggregateLiveSessions(lists.map((session) => ({ session, session_status: {} })))
        expect(result.map((session) => session.title)).toEqual(reference(lists).map((session) => session.title))
      }
    }
  })

  test('keeps the previous array when a replaced record loses to a fresher copy elsewhere', () => {
    const fresh = record('ses_a', 10, 0)
    const stale = record('ses_a', 1, 0)
    const first = aggregateLiveSessions([{ session: [stale], session_status: {} }, { session: [fresh], session_status: {} }])
    const second = aggregateLiveSessions([{ session: [record("ses_a", 2, 1)], session_status: {} }, { session: [fresh], session_status: {} }])
    expect(second).toBe(first)
  })
})
