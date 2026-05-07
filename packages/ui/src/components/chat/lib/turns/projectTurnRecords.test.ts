import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2'
import { projectTurnRecords } from './projectTurnRecords'
import type { ChatMessageEntry } from './types'

function createMessageEntry({
  id,
  role,
  parentID,
  createdAt,
}: {
  id: string
  role: 'user' | 'assistant'
  parentID?: string
  createdAt: number
}): ChatMessageEntry {
  return {
    info: {
      id,
      role,
      ...(parentID ? { parentID } : {}),
      time: { created: createdAt },
    } as Message,
    parts: [] as Part[],
  }
}

describe('projectTurnRecords', () => {
  test('keeps out-of-order assistant replies attached to their own user turn', () => {
    const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 })
    const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 })
    const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 })
    const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 })

    const projection = projectTurnRecords([user1, assistant1, assistant2, user2])

    expect(projection.turns).toHaveLength(2)
    expect(projection.turns[0]?.turnId).toBe('u1')
    expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1'])
    expect(projection.turns[1]?.turnId).toBe('u2')
    expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2'])
    expect(projection.ungroupedMessageIds.size).toBe(0)
  })

  test('resolves deferred assistant chains once the parent assistant arrives', () => {
    const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 })
    const assistantChild = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'a1', createdAt: 3 })
    const assistantParent = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 })

    const projection = projectTurnRecords([user, assistantChild, assistantParent])

    expect(projection.turns).toHaveLength(1)
    expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2'])
    expect(projection.ungroupedMessageIds.size).toBe(0)
  })
})
