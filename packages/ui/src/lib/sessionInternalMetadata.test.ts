import { describe, expect, test } from 'bun:test'
import type { Event, Session } from '@opencode-ai/sdk/v2/client'
import {
  isOpenChamberInternalSessionEvent,
  getOpenChamberInternalSessionGeneration,
  resetOpenChamberInternalSessions,
  visibleOpenCodeSessions,
} from './sessionInternalMetadata'

const session = (id: string, metadata?: Session['metadata']): Session => ({
  id, slug: id, projectID: 'project', directory: '/repo', title: id, version: '1',
  time: { created: 1, updated: 1 }, metadata,
})

// SAFETY: The test constructs the exact session.created event fields consumed by the predicate.
const created = (info: Session): Event => ({ id: 'evt_created', type: 'session.created', properties: { info } } as Event)

describe('internal session metadata', () => {
  test('runtime reset prevents an internal id from hiding a colliding user session', () => {
    const internal = session('ses_collision', { openchamber: { internalSession: { kind: 'walkthrough-inference', version: 1 } } })
    expect(isOpenChamberInternalSessionEvent(created(internal))).toBe(true)
    resetOpenChamberInternalSessions()
    expect(isOpenChamberInternalSessionEvent(created(session('ses_collision')))).toBe(false)
  })

  test('metadata-bearing delete is hidden and always clears the id', () => {
    // SAFETY: OpenCode's current deletion payload can include the deleted session as properties.info.
    const deleted = {
      id: 'evt_deleted',
      type: 'session.deleted',
      properties: { info: session('ses_delete', { openchamber: { internalSession: { kind: 'walkthrough-inference' } } }) },
    } as Event
    expect(isOpenChamberInternalSessionEvent(deleted)).toBe(true)
    // SAFETY: The test constructs the exact session.idle fields consumed by the predicate.
    expect(isOpenChamberInternalSessionEvent({ id: 'evt_idle', type: 'session.idle', properties: { sessionID: 'ses_delete' } } as Event)).toBe(false)
  })

  test('stale list filtering hides marked records without repopulating ids after a runtime switch', () => {
    const runtimeAGeneration = getOpenChamberInternalSessionGeneration()
    resetOpenChamberInternalSessions()
    const marked = session('ses_race', { openchamber: { internalSession: { kind: 'walkthrough-inference' } } })
    expect(visibleOpenCodeSessions([marked], runtimeAGeneration)).toEqual([])
    expect(isOpenChamberInternalSessionEvent(created(session('ses_race')))).toBe(false)
  })

  test('current list filtering registers marked ids for later id-only events', () => {
    const generation = getOpenChamberInternalSessionGeneration()
    const marked = session('ses_current', { openchamber: { internalSession: { kind: 'walkthrough-inference' } } })
    expect(visibleOpenCodeSessions([marked], generation)).toEqual([])
    // SAFETY: The test constructs the exact session.idle fields consumed by the predicate.
    expect(isOpenChamberInternalSessionEvent({ id: 'evt_current', type: 'session.idle', properties: { sessionID: 'ses_current' } } as Event)).toBe(true)
  })

  test('stale deletion cannot clear a current-runtime classification', () => {
    const staleGeneration = getOpenChamberInternalSessionGeneration()
    resetOpenChamberInternalSessions()
    const marked = session('ses_delete_collision', { openchamber: { internalSession: { kind: 'walkthrough-inference' } } })
    expect(isOpenChamberInternalSessionEvent(created(marked))).toBe(true)
    // SAFETY: The test constructs the SDK session.deleted fields consumed by the predicate.
    expect(isOpenChamberInternalSessionEvent({
      id: 'evt_stale_delete', type: 'session.deleted', properties: { sessionID: marked.id },
    } as Event, staleGeneration)).toBe(false)
    // SAFETY: The test constructs the SDK session.idle fields consumed by the predicate.
    expect(isOpenChamberInternalSessionEvent({
      id: 'evt_current_idle', type: 'session.idle', properties: { sessionID: marked.id },
    } as Event)).toBe(true)
  })
})
