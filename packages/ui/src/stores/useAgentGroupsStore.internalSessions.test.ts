import { describe, expect, mock, test } from 'bun:test'
import type { Event, Session } from '@opencode-ai/sdk/v2/client'
import { isOpenChamberInternalSessionEvent, resetOpenChamberInternalSessions } from '@/lib/sessionInternalMetadata'

mock.module('@/lib/worktrees/worktreeManager', () => ({
  listProjectWorktrees: async () => [],
  removeProjectWorktree: async () => undefined,
}))

const { listVisibleAgentGroupSessions } = await import('./useAgentGroupsStore')

describe('agent group internal session filtering', () => {
  test('registers a marked session from the successful runtime-B retry attempt', async () => {
    let attempts = 0
    const marked: Session = {
      id: 'ses_agent_retry', slug: 'agent-retry', projectID: 'project', directory: '/runtime-b',
      title: 'group/provider/model', version: '1', time: { created: 1, updated: 2 },
      metadata: { openchamber: { internalSession: { kind: 'walkthrough-inference' } } },
    }
    const api = {
      session: { list: async () => {
        attempts += 1
        if (attempts === 1) {
          resetOpenChamberInternalSessions()
          throw new Error('failed to fetch from runtime A')
        }
        return { data: [marked], error: undefined }
      } },
    }

    // SAFETY: The mock implements the session.list portion consumed by this focused boundary helper.
    expect(await listVisibleAgentGroupSessions(api as Parameters<typeof listVisibleAgentGroupSessions>[0], '/runtime-b')).toEqual([])
    // SAFETY: The fixture contains the SDK session.idle fields consumed by the event predicate.
    expect(isOpenChamberInternalSessionEvent({
      id: 'evt_agent_retry', type: 'session.idle', properties: { sessionID: marked.id },
    } as Event)).toBe(true)
  })
})
