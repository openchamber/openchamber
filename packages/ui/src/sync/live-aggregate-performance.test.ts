import { describe, expect, test } from 'bun:test'
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2/client'

import { aggregateLiveSessionStatuses } from './live-aggregate'
import {
  getSyncPerformanceDiagnostics,
  setSyncPerformanceDiagnosticsEnabled,
} from './performance-diagnostics'

describe('aggregateLiveSessionStatuses performance', () => {
  test('indexes 50 sessions once instead of scanning the list per status', () => {
    const sessions = Array.from({ length: 50 }, (_, index) => ({
      id: `session-${index}`,
      time: { created: index, updated: index },
    })) as Session[]
    const session_status = Object.fromEntries(
      sessions.map((session) => [session.id, { type: 'busy' } as SessionStatus]),
    )
    setSyncPerformanceDiagnosticsEnabled(true)

    const statuses = aggregateLiveSessionStatuses([{ session: sessions, session_status }])
    const diagnostics = getSyncPerformanceDiagnostics()

    expect(Object.keys(statuses)).toHaveLength(50)
    expect(diagnostics?.statusAggregationSessionEntries).toBe(50)
    expect(diagnostics?.statusAggregationCandidates).toBe(50)
    setSyncPerformanceDiagnosticsEnabled(false)
  })
})
